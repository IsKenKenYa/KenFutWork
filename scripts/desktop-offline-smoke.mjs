/**
 * 桌面离线冒烟：使用 release/ 中的平台产物和独占临时数据目录。
 *
 *   node scripts/desktop-offline-smoke.mjs
 *   node scripts/desktop-offline-smoke.mjs --data-dir <全新目录> --keep-data
 *
 * 不依赖仓库 tsx 或宿主 Node 启动服务，也不访问外部模型服务。
 * 桌面凭据仅在脚本侧读取；浏览器通过一次性票据换 HttpOnly cookie。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const RELEASE = join(process.cwd(), "release");
const args = process.argv.slice(2);
const dataDirArg = args.indexOf("--data-dir");
const keepData = args.includes("--keep-data");

// 仅用于产物协议验收的固定假Key与同步预算，不属于产品运行时治理。
const SMOKE_BYOK_KEY = "fake-desktop-byok-protocol-only";
const SMOKE_CHAT_MODEL = "desktop-smoke-chat";
const SMOKE_IMAGE_MODEL = "desktop-smoke-image";
const SMOKE_CHAT_TEXT = "BYOK_DESKTOP_SMOKE_OK";
const SMOKE_TOOL_PROMPT = "BYOK_DESKTOP_NATIVE_WRITE_SMOKE";
const SMOKE_TOOL_FILE = "smoke-generated.txt";
const SMOKE_TOOL_CONTENT = "BYOK_WRITTEN_BY_NATIVE_TOOL\n";
const SMOKE_WRITE_CALL = "call_desktop_smoke_write";
const SMOKE_READ_CALL = "call_desktop_smoke_read";
const SMOKE_RESUME_PROMPT = "BYOK_DESKTOP_RESUME_AFTER_BACKUP";
const SMOKE_RESUME_TEXT = "BYOK_DESKTOP_RESUME_AFTER_BACKUP_OK";
const SMOKE_VIDEO_MODEL = "metaso/minimax-h3";
const SMOKE_VIDEO_TASK = "desktop-smoke-video-task";
// 验收等待期限可按运行硬件显式声明：托管 CI runner 是 3 核 / 7GB，与开发机不是一个量级。
// 放宽的只是等待窗口，不是断言强度——期限内拿不到 checkpoint 依旧判失败。
const byokTimeoutEnv = Number(process.env.KFW_SMOKE_BYOK_TIMEOUT_MS);
const SMOKE_BYOK_TIMEOUT_MS =
  Number.isInteger(byokTimeoutEnv) && byokTimeoutEnv > 0
    ? byokTimeoutEnv
    : 120_000;
const SMOKE_BYOK_POLL_MS = 100;
const SMOKE_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=",
  "base64",
);
// 仅验证视频协议产物搬运，不声明该最小容器fixture可播放或有模型生成画面。
const SMOKE_VIDEO_BYTES = Buffer.from(
  "000000186674797069736f6d0000020069736f6d69736f32000000086d646174",
  "hex",
);

function log(message) {
  console.log(`[冒烟] ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function packagedCommand() {
  if (process.platform === "win32") {
    return { command: join(RELEASE, "KenFutWork-server.exe"), args: [] };
  }
  requireCondition(
    process.platform === "darwin",
    "冒烟仅支持现有 Windows 与 macOS 桌面产物。",
  );
  return {
    command: join(RELEASE, "runtime", "node", "bin", "node"),
    args: [join(RELEASE, "server", "server.cjs")],
  };
}

async function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port > 0 ? resolvePort(port) : reject(new Error("无法分配本机端口。")),
      );
    });
  });
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  return {
    body: await response.text(),
    status: response.status,
    headers: response.headers,
  };
}

function jsonRequest(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function expectStatus(base, path, status, init = {}) {
  const result = await request(base, path, init);
  requireCondition(
    result.status === status,
    `${path} 期望 ${status}，实际 ${result.status}。`,
  );
  return result;
}

async function waitForReady(base, child, readSpawnError) {
  const deadline = Date.now() + 120_000;
  let lastError = "尚未收到健康响应";
  while (Date.now() < deadline) {
    requireCondition(!readSpawnError(), "打包服务端未能启动。");
    requireCondition(
      child.exitCode === null && child.signalCode === null,
      "服务端在就绪前退出。",
    );
    try {
      const { status } = await request(base, "/api/health");
      if (status === 200) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`等待就绪超时（最后状态：${lastError}）。`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => {
    const timer = setTimeout(() => done(false), 20_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });
  child.kill("SIGTERM");
  if (await exited) return;
  child.kill("SIGKILL");
  throw new Error("服务端未在 20 秒内退出，已强制停止；保留数据目录供检查。");
}

function stopDatabase(dataDir) {
  const pgDataDir = join(dataDir, "postgres");
  if (!existsSync(join(pgDataDir, "PG_VERSION"))) return;
  const command = join(
    RELEASE,
    "pg",
    "bin",
    process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
  );
  const status = () =>
    spawnSync(command, ["-D", pgDataDir, "status"], { stdio: "ignore" });
  const initial = status();
  requireCondition(!initial.error, "无法检查内嵌数据库是否已停止。");
  if (initial.status === 0) {
    const stopped = spawnSync(
      command,
      ["-D", pgDataDir, "-m", "fast", "-w", "stop"],
      { stdio: "ignore" },
    );
    requireCondition(
      stopped.status === 0,
      "内嵌数据库关停失败；保留数据目录供检查。",
    );
  }
  const final = status();
  requireCondition(
    !final.error && final.status === 3,
    "内嵌数据库未确认停止；保留数据目录供检查。",
  );
}

async function readDesktopContext(base, dataDir) {
  // 长期桌面凭据从不进入URL或脚本输出。
  const token = (
    await readFile(join(dataDir, "local-access", "desktop-token"), "utf8")
  ).trim();
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token), "桌面接入凭据格式无效。");
  const desktopHeaders = { authorization: `Bearer ${token}` };
  const desktop = JSON.parse(
    (
      await expectStatus(base, "/api/instance", 200, {
        headers: desktopHeaders,
      })
    ).body,
  );
  requireCondition(
    typeof desktop.instanceId === "string" && desktop.dataDir === dataDir,
    "本机实例引导结果或数据目录不一致。",
  );
  requireCondition(
    Object.keys(desktop).sort().join(",") === "dataDir,instanceId",
    "本机实例接口仍含账户或额外身份字段。",
  );

  for (const path of [
    "/api/instance",
    "/api/models",
    "/api/projects",
    "/api/instance/skills",
  ]) {
    await expectStatus(base, path, 401);
    await expectStatus(base, path, 401, {
      headers: { authorization: `Bearer ${"A".repeat(43)}` },
    });
    await expectStatus(base, path, 200, { headers: desktopHeaders });
  }
  log("✓ 桌面凭据可访问本机实例，缺失与伪造凭据均被拒绝");
  return { desktop, desktopHeaders };
}

async function connectBrowser(base, desktop, desktopHeaders) {
  const ticketResponse = await expectStatus(
    base,
    "/api/local-access/tickets",
    201,
    jsonRequest({}, desktopHeaders),
  );
  const { ticket } = JSON.parse(ticketResponse.body);
  requireCondition(
    typeof ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(ticket),
    "未签发有效连接票据。",
  );
  const connected = await expectStatus(
    base,
    "/api/local-access/connect",
    200,
    jsonRequest({ ticket, label: "离线冒烟浏览器" }, { origin: base }),
  );
  const setCookie = connected.headers.get("set-cookie") ?? "";
  requireCondition(
    /; HttpOnly(?:;|$)/i.test(setCookie) &&
      /; SameSite=Strict(?:;|$)/i.test(setCookie),
    "浏览器会话cookie缺少 HttpOnly 或 SameSite=Strict。",
  );
  const browserHeaders = { cookie: setCookie.split(";")[0], origin: base };
  const browser = JSON.parse(
    (
      await expectStatus(base, "/api/instance", 200, {
        headers: browserHeaders,
      })
    ).body,
  );
  requireCondition(
    browser.instanceId === desktop.instanceId &&
      browser.dataDir === desktop.dataDir,
    "桌面与浏览器连接了不同实例。",
  );
  requireCondition(
    JSON.parse(connected.body).instanceId === desktop.instanceId,
    "票据兑换结果不属于桌面实例。",
  );
  await expectStatus(
    base,
    "/api/local-access/connect",
    401,
    jsonRequest({ ticket }, { origin: base }),
  );
  return browserHeaders;
}

async function verifySharedProjects(
  base,
  desktop,
  desktopHeaders,
  browserHeaders,
) {
  const created = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/projects",
        201,
        jsonRequest({ name: "离线冒烟项目", kind: "design" }, desktopHeaders),
      )
    ).body,
  );
  const projects = JSON.parse(
    (
      await expectStatus(base, "/api/projects?kind=design", 200, {
        headers: browserHeaders,
      })
    ).body,
  );
  requireCondition(
    created.project?.instanceId === desktop.instanceId &&
      projects.projects.some((project) => project.id === created.project.id),
    "浏览器未读取到桌面创建的实例项目。",
  );
  log("✓ 一次性票据建立浏览器会话，桌面与浏览器共享真实项目数据");
}

async function verifyScriptAccess(base, desktop, desktopHeaders) {
  const script = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/local-access/clients",
        201,
        jsonRequest({ label: "离线冒烟脚本" }, desktopHeaders),
      )
    ).body,
  );
  const scriptInstance = JSON.parse(
    (
      await expectStatus(base, "/api/instance", 200, {
        headers: { authorization: `Bearer ${script.token}` },
      })
    ).body,
  );
  requireCondition(
    scriptInstance.instanceId === desktop.instanceId,
    "显式授权脚本未连接原实例。",
  );
  await expectStatus(
    base,
    `/api/local-access/clients/${script.client.id}`,
    204,
    { method: "DELETE", headers: desktopHeaders },
  );
  await expectStatus(base, "/api/instance", 401, {
    headers: { authorization: `Bearer ${script.token}` },
  });
  log("✓ 脚本凭据显式授权且可独立撤销");
}

async function verifyRetiredRoutes(base, desktopHeaders) {
  for (const path of [
    "/api/viewer",
    "/api/admin/me",
    "/api/admin/users",
    "/api/credits",
    "/api/payments/plans",
  ]) {
    await expectStatus(base, path, 404, { headers: desktopHeaders });
  }
  await expectStatus(
    base,
    "/api/auth/login",
    404,
    jsonRequest({ email: "x@y.test", password: "irrelevant" }, desktopHeaders),
  );
  await expectStatus(base, "/api/instance", 403, {
    headers: { ...desktopHeaders, origin: "https://evil.example.com" },
  });
  log("✓ 旧账户与商业接口已退役，跨源请求被拒绝");
}

async function verifyLocalAccess(base, dataDir) {
  const { desktop, desktopHeaders } = await readDesktopContext(base, dataDir);
  const browserHeaders = await connectBrowser(base, desktop, desktopHeaders);
  await verifySharedProjects(base, desktop, desktopHeaders, browserHeaders);
  await verifyScriptAccess(base, desktop, desktopHeaders);
  await verifyRetiredRoutes(base, desktopHeaders);
  return desktopHeaders;
}

function fixtureJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function fixtureRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("本机上游fixture收到无效JSON。");
  }
}

function fixtureChatReply(body) {
  const lastUser = body.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const input = JSON.stringify(body.messages[lastUser]?.content ?? "");
  if (!input.includes(SMOKE_TOOL_PROMPT))
    return {
      content: input.includes(SMOKE_RESUME_PROMPT)
        ? SMOKE_RESUME_TEXT
        : SMOKE_CHAT_TEXT,
      finishReason: "stop",
    };
  const results = body.messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "tool");
  const wrote = results.find((message) =>
    message.tool_call_id?.endsWith(SMOKE_WRITE_CALL),
  );
  const read = results.find((message) =>
    message.tool_call_id?.endsWith(SMOKE_READ_CALL),
  );
  if (read) {
    requireCondition(
      JSON.stringify(read.content).includes(SMOKE_TOOL_CONTENT.trim()),
      "实际Read工具没有返回实际Write提交的文件内容。",
    );
    return { content: SMOKE_CHAT_TEXT, finishReason: "stop" };
  }
  const name = wrote ? "Read" : "Write";
  requireCondition(
    body.tools?.some(
      (tool) => tool.type === "function" && tool.function?.name === name,
    ),
    `实际Code模型请求没有挂载${name}工具schema。`,
  );
  const args = wrote
    ? { file_path: SMOKE_TOOL_FILE }
    : {
        file_path: SMOKE_TOOL_FILE,
        content: SMOKE_TOOL_CONTENT,
        create_only: true,
      };
  return {
    content: null,
    finishReason: "tool_calls",
    toolCall: {
      id: wrote ? SMOKE_READ_CALL : SMOKE_WRITE_CALL,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}

function fixtureChatCompletion(response, body, count) {
  const reply = fixtureChatReply(body);
  const common = {
    id: `chatcmpl-desktop-smoke-${count}`,
    created: 1,
    model: SMOKE_CHAT_MODEL,
  };
  const usage = { prompt_tokens: 17, completion_tokens: 11, total_tokens: 28 };
  if (!body.stream) {
    return fixtureJson(response, 200, {
      ...common,
      object: "chat.completion",
      usage,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply.content,
            ...(reply.toolCall ? { tool_calls: [reply.toolCall] } : {}),
          },
          finish_reason: reply.finishReason,
        },
      ],
    });
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const frame of [
    {
      ...common,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: reply.content,
            ...(reply.toolCall
              ? { tool_calls: [{ index: 0, ...reply.toolCall }] }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...common,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason }],
    },
    { ...common, object: "chat.completion.chunk", choices: [], usage },
  ])
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function createByokProtocolUpstream() {
  let base;
  const calls = {
    chat: [],
    images: [],
    downloads: 0,
    videoSubmit: [],
    videoPoll: 0,
    videoDownloads: 0,
    failures: [],
  };
  const handle = async (request, response) => {
    if (request.method === "GET" && request.url === "/artifacts/smoke.png") {
      calls.downloads += 1;
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": SMOKE_IMAGE_BYTES.length,
      });
      return response.end(SMOKE_IMAGE_BYTES);
    }
    if (request.method === "GET" && request.url === "/artifacts/smoke.mp4") {
      calls.videoDownloads += 1;
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": SMOKE_VIDEO_BYTES.length,
      });
      return response.end(SMOKE_VIDEO_BYTES);
    }
    requireCondition(
      request.headers.authorization === `Bearer ${SMOKE_BYOK_KEY}`,
      "模型adapter未使用明文BYOK凭据进行本机协议请求。",
    );
    if (
      request.method === "GET" &&
      request.url === `/metaso/v2/query/video_generation/${SMOKE_VIDEO_TASK}`
    ) {
      calls.videoPoll += 1;
      return fixtureJson(response, 200, {
        task: {
          id: SMOKE_VIDEO_TASK,
          status: "succeeded",
          modality: "video",
          content: { url: `${base}/artifacts/smoke.mp4` },
          duration: 4,
          resolution: "768P",
          ratio: "16:9",
        },
      });
    }
    requireCondition(
      request.method === "POST",
      "本机上游fixture只接受已核对的生成POST协议。",
    );
    const body = await fixtureRequestBody(request);
    requireCondition(
      !JSON.stringify(body).includes(SMOKE_BYOK_KEY),
      "BYOK Key进入了模型请求正文。",
    );
    if (request.url === "/v1/chat/completions") {
      requireCondition(
        body.model === SMOKE_CHAT_MODEL && Array.isArray(body.messages),
        "实际聊天adapter请求未使用目标模型或messages协议。",
      );
      calls.chat.push(body);
      return fixtureChatCompletion(response, body, calls.chat.length);
    }
    if (request.url === "/v1/images/generations") {
      requireCondition(
        body.model === SMOKE_IMAGE_MODEL && typeof body.prompt === "string",
        "实际图像adapter请求未使用目标模型或prompt协议。",
      );
      calls.images.push(body);
      return fixtureJson(response, 200, {
        created: 1,
        data: [{ url: `${base}/artifacts/smoke.png` }],
      });
    }
    if (request.url === "/metaso/v2/video_generation") {
      requireCondition(
        body.model === "MiniMax-H3" &&
          Array.isArray(body.content) &&
          body.duration === 4 &&
          body.resolution === "768P" &&
          body.ratio === "16:9",
        "实际Metaso adapter请求不符合已核对的公开协议。",
      );
      calls.videoSubmit.push(body);
      return fixtureJson(response, 200, { task_id: SMOKE_VIDEO_TASK });
    }
    throw new Error("实际adapter请求了本机fixture未声明的协议端点。");
  };
  const server = createHttpServer((request, response) => {
    void Promise.resolve()
      .then(() => handle(request, response))
      .catch((error) => {
        calls.failures.push(
          error instanceof Error ? error.message : "本机fixture协议失败",
        );
        if (response.headersSent) response.destroy();
        else
          fixtureJson(response, 400, {
            error: { message: "desktop protocol fixture rejected request" },
          });
      });
  });
  await new Promise((listening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      listening();
    });
  });
  const address = server.address();
  requireCondition(
    typeof address === "object" && address?.port,
    "无法分配BYOK协议fixture回环端口。",
  );
  base = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: `${base}/v1`,
    videoBaseUrl: `${base}/metaso/`,
    calls,
    close: () =>
      new Promise((done, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}

async function waitForByokResult(read, description, diagnose) {
  const deadline = Date.now() + SMOKE_BYOK_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, SMOKE_BYOK_POLL_MS));
  }
  // 超时时把现场打出来：只报「没等到」会逼着人去猜是服务端没做、还是接口口径不对。
  const scene = diagnose ? ` 现场：${diagnose().slice(0, 600)}` : "";
  throw new Error(
    `${description}未在产物验收期限内完成（轮询 ${attempts} 次 / ${SMOKE_BYOK_TIMEOUT_MS / 1000}s）。${scene}`,
  );
}

async function openByokCodeStream(base, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMOKE_BYOK_TIMEOUT_MS);
  const response = await fetch(`${base}/api/code-ui/events`, {
    headers: { ...headers, origin: base },
    signal: controller.signal,
  }).catch((error) => {
    clearTimeout(timer);
    throw error;
  });
  if (response.status !== 200 || !response.body) {
    controller.abort();
    clearTimeout(timer);
    throw new Error("真实Code SSE连接未获授权或未返回事件流。");
  }
  const reader = response.body.getReader();
  const events = [];
  let failure;
  const pumping = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error("真实Code SSE提前关闭。");
        buffer += decoder.decode(next.value, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/u.exec(buffer);
          if (!boundary) break;
          const record = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = record
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) failure = error;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  })();
  const waitFor = (predicate, description) =>
    waitForByokResult(() => {
      if (failure) throw failure;
      requireCondition(
        !controller.signal.aborted,
        "真实Code SSE达到验收期限或已关闭。",
      );
      return events.find(predicate);
    }, description);
  const ready = await waitFor(
    (event) => event.event === "ready",
    "Code原协议hello",
  ).catch(async (error) => {
    controller.abort();
    await pumping;
    throw error;
  });
  const clientId = randomUUID();
  try {
    requireCondition(
      ready.hello?.protocolVersion === 3 &&
        typeof ready.hello.connectionId === "string",
      "Code SSE没有返回原V4的真实连接身份。",
    );
    await byokRpc(
      base,
      headers,
      ready.hello.connectionId,
      "zcodeAgentService",
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: 3,
          clientId,
          appVersion: "desktop-byok-protocol-smoke",
          clientKind: "web",
        },
      ],
    );
  } catch (error) {
    controller.abort();
    await pumping;
    throw error;
  }
  return {
    events,
    ready,
    clientId,
    waitFor,
    async close() {
      controller.abort();
      await pumping;
    },
  };
}

async function byokRpc(
  base,
  headers,
  connectionId,
  service,
  method,
  rpcArgs = [],
  status = 200,
) {
  const response = await expectStatus(
    base,
    "/api/code-ui/rpc",
    status,
    jsonRequest({ connectionId, service, method, args: rpcArgs }, headers),
  );
  return JSON.parse(response.body);
}

async function saveByokSmokeProvider(
  base,
  dataDir,
  headers,
  connectionId,
  upstream,
) {
  const provider = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/provider-instances",
        201,
        jsonRequest(
          {
            name: "BYOK产物协议冒烟",
            protocol: "openai-compatible",
            baseUrl: upstream.baseUrl,
            apiKey: SMOKE_BYOK_KEY,
            enabled: true,
            compat: { chatApi: "completions", supportsToolCalling: true },
            models: [
              {
                id: SMOKE_CHAT_MODEL,
                name: "本机协议聊天",
                capability: "chat",
                contextWindow: 32_768,
                maxOutputTokens: 2_048,
              },
              {
                id: SMOKE_IMAGE_MODEL,
                name: "本机协议图像",
                capability: "image",
              },
            ],
          },
          headers,
        ),
      )
    ).body,
  );
  requireCondition(
    typeof provider.id === "string" &&
      provider.hasCredential &&
      provider.configRevision > 0,
    "真实供应商保存未返回凭据状态与修订号。",
  );
  const overlay = {
    api: { type: "openai-chat-completions", baseUrl: upstream.baseUrl },
    access: { type: "api-key", apiKey: SMOKE_BYOK_KEY },
  };
  await byokRpc(
    base,
    headers,
    connectionId,
    "providerSettingsService",
    "savePersonalProviderOverlay",
    [
      provider.id,
      overlay,
      {
        providerName: "BYOK产物协议已保存",
        expectedRevision: provider.configRevision,
      },
    ],
  );
  await byokRpc(
    base,
    headers,
    connectionId,
    "providerSettingsService",
    "savePersonalProviderOverlay",
    [
      provider.id,
      {
        ...overlay,
        access: { type: "api-key", apiKey: "fake-stale-write-must-rollback" },
      },
      { expectedRevision: provider.configRevision },
    ],
    409,
  );
  const view = await byokRpc(
    base,
    headers,
    connectionId,
    "providerSettingsService",
    "getView",
  );
  const editor = view.result.providers.find(
    (entry) => entry.providerId === provider.id,
  );
  requireCondition(
    editor?.effectiveConfig.access?.apiKey === SMOKE_BYOK_KEY &&
      editor.personalConfig?.access?.apiKey === SMOKE_BYOK_KEY,
    "授权原供应商设置未显示实际Key，或旧CAS写入污染了凭据。",
  );
  const plaintext = JSON.parse(
    await readFile(join(dataDir, "credentials", "byok.json"), "utf8"),
  );
  requireCondition(
    plaintext[provider.id] === SMOKE_BYOK_KEY,
    "BYOK Key未以明文保存在独占数据根，或CAS失败后未恢复。",
  );
  for (const path of [
    "/api/models",
    "/api/image-models",
    "/api/provider-instances",
  ]) {
    const directory = await expectStatus(base, path, 200, { headers });
    requireCondition(
      !directory.body.includes(SMOKE_BYOK_KEY) &&
        !directory.body.includes("fake-stale-write-must-rollback"),
      "普通模型目录泄露了供应商Key。",
    );
  }
  const instances = JSON.parse(
    (await expectStatus(base, "/api/provider-instances", 200, { headers }))
      .body,
  ).instances;
  requireCondition(
    instances.find((entry) => entry.id === provider.id)?.configRevision >
      provider.configRevision,
    "原设置RPC未推进真实供应商修订号。",
  );
  await expectStatus(base, "/api/instance/settings", 200, {
    ...jsonRequest(
      { defaultModel: `${provider.id}:${SMOKE_CHAT_MODEL}` },
      headers,
    ),
    method: "PATCH",
  });
  log(
    "✓ 实际供应商服务保存明文Key，原设置RPC显示/保存与CAS冲突回滚正常，普通目录无Key",
  );
  return provider.id;
}

function codeSnapshotFromEvent(event) {
  return event.event === "onDynamicConversationFrame"
    ? event.frame?.frame?.payload?.snapshot
    : undefined;
}

function waitForCompletedByokConversation(stream, expectedText, description) {
  return stream.waitFor((event) => {
    const snapshot = codeSnapshotFromEvent(event);
    if (!snapshot) return false;
    if (
      snapshot.control.phase.startsWith("completed") &&
      snapshot.control.phase !== "completedSuccess"
    )
      throw new Error(`Code Run终态为${snapshot.control.phase}。`);
    return (
      snapshot.control.phase === "completedSuccess" &&
      snapshot.rows.window.some(
        (row) =>
          row.kind === "assistantText" && row.text?.includes(expectedText),
      )
    );
  }, description);
}

function requireCompletedByokSnapshot(
  snapshot,
  expectedTurns = 1,
  expectedText = SMOKE_CHAT_TEXT,
) {
  requireCondition(
    snapshot?.control?.phase === "completedSuccess",
    "真实BYOK Code Run未成功完成。",
  );
  const rows = snapshot.rows.window;
  requireCondition(
    rows.filter((row) => row.kind === "userInput").length === expectedTurns,
    "同键Code输入重放产生了重复用户输入。",
  );
  requireCondition(
    rows.filter((row) => row.kind === "turnHeader").length === expectedTurns,
    "同键Code输入重放产生了第二个Run。",
  );
  requireCondition(
    rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => row.text ?? "")
      .join("")
      .includes(expectedText),
    "原V4会话未持久化实际模型adapter返回的正文。",
  );
}

async function requireNativeSmokeCheckpoints(
  base,
  headers,
  taskId,
  projectId,
  workspacePath,
  expectedIds,
) {
  const query = new URLSearchParams({ taskId }).toString();
  let lastBody = "";
  // completedSuccess先投影到UI；post捕获仍在同一Run的finally中收尾。
  const checkpoints = await waitForByokResult(
    async () => {
      const response = await expectStatus(
        base,
        `/api/code/checkpoints?${query}`,
        200,
        { headers },
      );
      lastBody = response.body ?? "";
      const items = JSON.parse(lastBody).checkpoints;
      return Array.isArray(items) && items.length > 0 ? items : null;
    },
    "实际Write/Read完成后的持久shadow checkpoint",
    () => `GET /api/code/checkpoints?${query} → ${lastBody}`,
  );
  requireCondition(
    checkpoints.every(
      (checkpoint) =>
        checkpoint.taskId === taskId && checkpoint.projectId === projectId,
    ),
    "公开checkpoint不属于真实Code Project/Task。",
  );
  if (expectedIds)
    requireCondition(
      JSON.stringify(checkpoints.map((checkpoint) => checkpoint.id).sort()) ===
        JSON.stringify([...expectedIds].sort()),
      "目录重启改变或丢失了原生checkpoint身份。",
    );
  const changed = checkpoints.findLast(
    (checkpoint) => checkpoint.filesChanged > 0,
  );
  requireCondition(changed, "原生checkpoint没有记录实际Write文件变更。");
  const diff = JSON.parse(
    (
      await expectStatus(
        base,
        `/api/code/checkpoints/${changed.id}/diff?${query}`,
        200,
        { headers },
      )
    ).body,
  );
  requireCondition(
    diff.diff.includes(SMOKE_TOOL_CONTENT.trim()) &&
      diff.files.some(
        (file) =>
          file.path === SMOKE_TOOL_FILE && file.rootDirectory === workspacePath,
      ),
    "真实checkpoint未包含工具提交字节或仍绑定错误Task目录。",
  );
  return checkpoints;
}

async function verifyByokCodeRun(
  base,
  dataDir,
  headers,
  stream,
  providerId,
  upstream,
) {
  const connectionId = stream.ready.hello.connectionId;
  const workspacePath = join(dataDir, "sandbox", "byok-smoke-code");
  await mkdir(workspacePath, { recursive: true });
  const created = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/projects",
        201,
        jsonRequest(
          { name: "BYOK Code产物冒烟", kind: "code", work_dir: workspacePath },
          headers,
        ),
      )
    ).body,
  );
  const projectId = created.project?.id;
  requireCondition(
    typeof projectId === "string" && created.project.kind === "code",
    "Code冒烟未创建真实Code Project。",
  );
  const selectionView = await byokRpc(
    base,
    headers,
    connectionId,
    "modelSelectionService",
    "getView",
  );
  const selection = selectionView.result.preferredSelection;
  requireCondition(
    selection?.providerId === providerId &&
      selection.modelId === SMOKE_CHAT_MODEL,
    "原模型选择器未使用本机BYOK供应商。",
  );
  const clientId = stream.clientId;
  const command = (envelope) =>
    byokRpc(
      base,
      headers,
      connectionId,
      "zcodeAgentService",
      "sendConversationCommandV4",
      [{ workspacePath, projectId, envelope }],
    );
  const bound = await command({
    commandId: randomUUID(),
    clientId,
    sessionId: null,
    type: "createSession",
    // 原wire身份字段只在宿主映射；Code从真实Project创建Task，不传canvas。
    payload: { workspaceId: projectId, config: { modelSelection: selection } },
    issuedAt: Date.now(),
  });
  const sessionId = bound.result?.result?.sessionId;
  requireCondition(
    typeof sessionId === "string",
    "原V4 createSession未返回持久Task身份。",
  );
  const initial = JSON.parse(
    (
      await expectStatus(base, `/api/code-ui/sessions/${sessionId}`, 200, {
        headers,
      })
    ).body,
  ).snapshot;
  await command({
    commandId: randomUUID(),
    clientId,
    sessionId,
    type: "switchCollaborationMode",
    payload: { mode: "edit" },
    issuedAt: Date.now(),
    baseRevision: initial.revision,
    baseLogEpoch: initial.logEpoch,
  });
  const editable = JSON.parse(
    (
      await expectStatus(base, `/api/code-ui/sessions/${sessionId}`, 200, {
        headers,
      })
    ).body,
  ).snapshot;
  requireCondition(
    editable.config.mode === "edit" && !editable.config.planEnabled,
    "原模式命令没有授权受控文件编辑；不以yolo绕过沙箱。",
  );
  await byokRpc(
    base,
    headers,
    connectionId,
    "zcodeAgentService",
    "subscribeConversationV4",
    [{ workspacePath, projectId, sessionId }],
  );
  const envelope = {
    commandId: randomUUID(),
    clientId,
    sessionId,
    type: "sendText",
    payload: {
      text: `这是本机协议验收 ${SMOKE_TOOL_PROMPT}。用Write在当前Task目录创建${SMOKE_TOOL_FILE}，内容为${SMOKE_TOOL_CONTENT.trim()}，再用Read核对内容，最后回复${SMOKE_CHAT_TEXT}。`,
      modelSelection: selection,
    },
    issuedAt: Date.now(),
  };
  const acknowledgements = await Promise.all([
    command(envelope),
    command(envelope),
  ]);
  requireCondition(
    acknowledgements
      .map((entry) => entry.result.status)
      .sort()
      .join(",") === "accepted,duplicate",
    "原V4同键输入未返回一次accepted与一次duplicate。",
  );
  const completed = await waitForCompletedByokConversation(
    stream,
    SMOKE_CHAT_TEXT,
    "实际BYOK聊天与原V4 SSE终态",
  );
  requireCompletedByokSnapshot(codeSnapshotFromEvent(completed));
  const restored = JSON.parse(
    (
      await expectStatus(base, `/api/code-ui/sessions/${sessionId}`, 200, {
        headers,
      })
    ).body,
  ).snapshot;
  requireCompletedByokSnapshot(restored);
  requireCondition(
    restored.rows.window.some(
      (row) =>
        row.kind === "toolCall" &&
        row.toolName === "Write" &&
        row.status === "success",
    ) &&
      restored.rows.window.some(
        (row) =>
          row.kind === "toolCall" &&
          row.toolName === "Read" &&
          row.status === "success",
      ),
    "原V4没有持久化实际Write/Read工具成功事实。",
  );
  requireCondition(
    (await readFile(join(workspacePath, SMOKE_TOOL_FILE), "utf8")) ===
      SMOKE_TOOL_CONTENT,
    "真实Write工具没有提交目标文件；不由脚本补文件。",
  );
  const checkpoints = await requireNativeSmokeCheckpoints(
    base,
    headers,
    sessionId,
    projectId,
    workspacePath,
  );
  const tasks = await byokRpc(
    base,
    headers,
    connectionId,
    "zcode-task",
    "listTasks",
    [{ workspacePath, projectId }],
  );
  requireCondition(
    tasks.result.some(
      (task) =>
        task.taskId === sessionId &&
        task.workspacePath === workspacePath &&
        task.status === "completed",
    ),
    "完成的Code Run未归属原Project/Task工作目录。",
  );
  requireCondition(
    upstream.calls.chat.length > 0 &&
      upstream.calls.chat.some((call) => call.stream === true),
    "实际BYOK聊天adapter未请求本机OpenAI兼容流式协议。",
  );
  log(
    "✓ 真实Code Project→Task→Run经原V4 HTTP/SSE完成BYOK聊天，同键重放与刷新恢复正常",
  );
  return {
    projectId,
    sessionId,
    workspacePath,
    selection,
    initialTurnIds: restored.rows.window
      .filter((row) => row.kind === "turnHeader")
      .map((row) => row.turnId),
    checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
  };
}

async function verifyByokStoredArtifact(
  base,
  dataDir,
  headers,
  url,
  assetId,
  objectPath,
  expectedBytes = SMOKE_IMAGE_BYTES,
) {
  requireCondition(
    typeof assetId === "string" && typeof url === "string",
    "生成产物未返回持久资产与本机URL。",
  );
  const signed = new URL(url);
  requireCondition(
    signed.origin === new URL(base).origin &&
      signed.pathname.startsWith("/api/blobs/project-assets/"),
    "生成产物未绑定实际本机blob地址。",
  );
  const downloaded = await fetch(signed, {
    headers,
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  requireCondition(
    downloaded.status === 200 &&
      Buffer.from(await downloaded.arrayBuffer()).equals(expectedBytes),
    "本机产物URL读取到的字节与实际上游产物不一致。",
  );
  const resolved = JSON.parse(
    (await expectStatus(base, `/api/uploads/${assetId}/url`, 200, { headers }))
      .body,
  );
  requireCondition(
    new URL(resolved.url).pathname === signed.pathname,
    "持久资产记录未指向原blob产物。",
  );
  const urlObject = decodeURIComponent(
    signed.pathname.slice("/api/blobs/project-assets/".length),
  );
  const relativeObject = objectPath ?? urlObject;
  requireCondition(
    relativeObject === urlObject,
    "生成job对象路径与实际资产URL不一致。",
  );
  requireCondition(
    !relativeObject
      .split(/[\\/]/u)
      .some((part) => part === ".." || part === "."),
    "产物对象路径不在本机blob根内。",
  );
  requireCondition(
    (
      await readFile(join(dataDir, "blobs", "project-assets", relativeObject))
    ).equals(expectedBytes),
    "下载产物未真实持久化到本机数据目录。",
  );
}

async function verifyByokImages(
  base,
  dataDir,
  headers,
  providerId,
  task,
  upstream,
) {
  const generated = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/agent/generate-image",
        200,
        jsonRequest(
          {
            prompt: "BYOK_DESKTOP_IMAGE_DIRECT",
            model: SMOKE_IMAGE_MODEL,
            providerInstanceId: providerId,
            aspectRatio: "1:1",
            sessionId: task.sessionId,
          },
          headers,
        ),
      )
    ).body,
  );
  await verifyByokStoredArtifact(
    base,
    dataDir,
    headers,
    generated.url,
    generated.assetId,
  );
  const accepted = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/jobs/image-generation",
        201,
        jsonRequest(
          {
            project_id: task.projectId,
            session_id: task.sessionId,
            prompt: "BYOK_DESKTOP_IMAGE_JOB",
            model: SMOKE_IMAGE_MODEL,
            provider_instance_id: providerId,
            aspect_ratio: "1:1",
          },
          headers,
        ),
      )
    ).body,
  );
  const completed = await waitForByokResult(async () => {
    const current = JSON.parse(
      (
        await expectStatus(base, `/api/jobs/${accepted.job.id}`, 200, {
          headers,
        })
      ).body,
    ).job;
    if (["failed", "canceled", "dead_letter"].includes(current.status))
      throw new Error(
        `真实图像job失败：${current.error_code ?? current.status}。`,
      );
    return current.status === "succeeded" ? current : undefined;
  }, "同一BYOK供应商的真实图像job终态");
  requireCondition(
    completed.project_id === task.projectId &&
      completed.session_id === task.sessionId &&
      completed.canvas_id === null,
    "Code图像job未保持Project/Task归属，或借用了Design画布。",
  );
  await verifyByokStoredArtifact(
    base,
    dataDir,
    headers,
    completed.result.signed_url,
    completed.result.asset_id,
    completed.result.object_path,
  );
  requireCondition(
    upstream.calls.images.length === 2 && upstream.calls.downloads === 2,
    "图像直连与后台job没有各自完成实际adapter请求与产物下载。",
  );
  log(
    "✓ 同一BYOK图像adapter直连与真实后台job均完成，产物下载、资产记录与本机文件持久化一致",
  );
  return {
    directAssetId: generated.assetId,
    imageJobId: completed.id,
    imageAssetId: completed.result.asset_id,
    imageObjectPath: completed.result.object_path,
  };
}

async function createExternalSmokeTask(
  base,
  headers,
  stream,
  selection,
  externalDir,
) {
  const project = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/projects",
        201,
        jsonRequest(
          {
            name: "外部目录不得随数据根移动",
            kind: "code",
            work_dir: externalDir,
          },
          headers,
        ),
      )
    ).body,
  ).project;
  const created = await byokRpc(
    base,
    headers,
    stream.ready.hello.connectionId,
    "zcodeAgentService",
    "sendConversationCommandV4",
    [
      {
        workspacePath: externalDir,
        projectId: project.id,
        envelope: {
          commandId: randomUUID(),
          clientId: stream.clientId,
          sessionId: null,
          type: "createSession",
          issuedAt: Date.now(),
          payload: {
            workspaceId: project.id,
            config: { modelSelection: selection },
          },
        },
      },
    ],
  );
  const sessionId = created.result?.result?.sessionId;
  requireCondition(
    typeof sessionId === "string" && project.workDir === externalDir,
    "外部Code Project/Task未绑定原授权目录。",
  );
  return { projectId: project.id, sessionId, workspacePath: externalDir };
}

async function verifyByokVideo(base, dataDir, headers, task, upstream) {
  // 实际Metaso adapter的公开v2受理/查询面；不假造OpenAI不存在的视频接口。
  const provider = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/provider-instances",
        201,
        jsonRequest(
          {
            name: "本机Metaso视频协议fixture",
            protocol: "metaso",
            baseUrl: upstream.videoBaseUrl,
            apiKey: SMOKE_BYOK_KEY,
            models: [
              {
                id: SMOKE_VIDEO_MODEL,
                name: "Metaso协议视频",
                capability: "video",
              },
            ],
          },
          headers,
        ),
      )
    ).body,
  );
  const accepted = JSON.parse(
    (
      await expectStatus(
        base,
        "/api/jobs/video-generation",
        201,
        jsonRequest(
          {
            project_id: task.projectId,
            session_id: task.sessionId,
            provider_instance_id: provider.id,
            model: SMOKE_VIDEO_MODEL,
            prompt: "BYOK_DESKTOP_VIDEO_PROTOCOL",
            duration: 4,
            resolution: "720p",
            aspect_ratio: "16:9",
          },
          headers,
        ),
      )
    ).body,
  );
  const completed = await waitForByokResult(async () => {
    const job = JSON.parse(
      (
        await expectStatus(base, `/api/jobs/${accepted.job.id}`, 200, {
          headers,
        })
      ).body,
    ).job;
    if (["failed", "canceled", "dead_letter"].includes(job.status))
      throw new Error(
        `Metaso真实视频job失败：${job.error_code ?? job.status}。`,
      );
    return job.status === "succeeded" ? job : undefined;
  }, "Metaso实际视频adapter与真实job终态");
  requireCondition(
    completed.project_id === task.projectId &&
      completed.session_id === task.sessionId &&
      completed.canvas_id === null &&
      completed.result.mime_type === "video/mp4",
    "视频job没有保留Code Project/Task归属或真实产物类型。",
  );
  await verifyByokStoredArtifact(
    base,
    dataDir,
    headers,
    completed.result.signed_url,
    completed.result.asset_id,
    completed.result.object_path,
    SMOKE_VIDEO_BYTES,
  );
  requireCondition(
    upstream.calls.videoSubmit.length === 1 &&
      upstream.calls.videoPoll === 1 &&
      upstream.calls.videoDownloads === 1,
    "Metaso视频受理、查询与产物下载没有各自真实完成。",
  );
  log(
    "✓ Metaso实际adapter经本机公开协议受理/查询后完成真实视频job与字节持久化（容器fixture，不评估画面）",
  );
  return {
    providerId: provider.id,
    jobId: completed.id,
    assetId: completed.result.asset_id,
    objectPath: completed.result.object_path,
  };
}

async function verifyByokPipeline(
  base,
  dataDir,
  desktopHeaders,
  upstream,
  externalDir,
) {
  let stream;
  try {
    stream = await openByokCodeStream(base, desktopHeaders);
    const providerId = await saveByokSmokeProvider(
      base,
      dataDir,
      desktopHeaders,
      stream.ready.hello.connectionId,
      upstream,
    );
    const task = await verifyByokCodeRun(
      base,
      dataDir,
      desktopHeaders,
      stream,
      providerId,
      upstream,
    );
    const images = await verifyByokImages(
      base,
      dataDir,
      desktopHeaders,
      providerId,
      task,
      upstream,
    );
    const external = await createExternalSmokeTask(
      base,
      desktopHeaders,
      stream,
      task.selection,
      externalDir,
    );
    const video = await verifyByokVideo(
      base,
      dataDir,
      desktopHeaders,
      task,
      upstream,
    );
    requireCondition(
      upstream.calls.failures.length === 0,
      "本机上游协议fixture存在请求形状或认证失败。",
    );
    requireCondition(
      !JSON.stringify(stream.events).includes(SMOKE_BYOK_KEY),
      "BYOK Key进入了普通Code SSE事件。",
    );
    log("✓ 本机fake上游验证了真实桌面产物的BYOK协议链路；未访问外部付费供应商");
    const instance = JSON.parse(
      (
        await expectStatus(base, "/api/instance", 200, {
          headers: desktopHeaders,
        })
      ).body,
    );
    return {
      providerId,
      task,
      images,
      external,
      video,
      instanceId: instance.instanceId,
    };
  } finally {
    await stream?.close();
  }
}

async function prepareSmokeDataDir(packaged) {
  for (const path of [
    packaged.command,
    ...packaged.args,
    join(RELEASE, "pg", "bin"),
    join(RELEASE, "web", "index.html"),
  ]) {
    requireCondition(
      existsSync(path),
      `缺少打包产物 ${path}，请先运行对应平台的 package 命令。`,
    );
  }
  requireCondition(
    dataDirArg < 0 ||
      (Boolean(args[dataDirArg + 1]) && !args[dataDirArg + 1].startsWith("--")),
    "--data-dir 缺少全新目录参数。",
  );
  const requestedDataDir =
    dataDirArg >= 0
      ? resolve(args[dataDirArg + 1])
      : await mkdtemp(join(tmpdir(), "kenfutwork-smoke-"));
  await mkdir(requestedDataDir, { recursive: true });
  const dataDir = await realpath(requestedDataDir);
  requireCondition(
    (await readdir(dataDir)).length === 0,
    "冒烟数据目录必须为空，避免覆盖或删除现有实例。",
  );
  return dataDir;
}

function smokeOsEnvironment() {
  // 测试产物只继承OS运行所需环境，不继承本机真实供应商/MCP/数据库/代理配置。
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|HOME|USER|LOGNAME|TMPDIR|TEMP|TMP|SYSTEMROOT|SystemRoot|COMSPEC|ComSpec|PATHEXT|LANG|LC_ALL|APPDATA|LOCALAPPDATA)$/.test(
        name,
      ),
    ),
  );
}

function startPackagedServer(packaged, dataDir, port, base, configDir) {
  const child = spawn(packaged.command, packaged.args, {
    cwd: RELEASE,
    env: {
      ...smokeOsEnvironment(),
      HOST: "127.0.0.1",
      KENFUTWORK_AGENT_MODEL:
        process.env.KENFUTWORK_AGENT_MODEL ?? "google:gemini-2.5-flash",
      ...(configDir
        ? { KENFUTWORK_CONFIG_DIR: configDir }
        : { KENFUTWORK_DATA_DIR: dataDir }),
      KENFUTWORK_BLOB_PUBLIC_BASE_URL: `${base}/api/blobs`,
      KENFUTWORK_EMBEDDED_PG: "1",
      KENFUTWORK_QUEUE_DRIVER: "in-process",
      KENFUTWORK_SERVER_PORT: String(port),
      KENFUTWORK_WEB_DIST: join(RELEASE, "web"),
      KENFUTWORK_WEB_ORIGIN: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  return { child, output, readSpawnError: () => spawnError };
}

async function withPackagedSmokeRuntime(
  packaged,
  dataDir,
  port,
  base,
  configDir,
  verify,
) {
  const { child, output, readSpawnError } = startPackagedServer(
    packaged,
    dataDir,
    port,
    base,
    configDir,
  );
  try {
    await waitForReady(base, child, readSpawnError);
    await expectStatus(base, "/", 200);
    return await verify();
  } catch (error) {
    // 接入凭据不写日志；这里只保留服务端输出与失败步骤。
    console.error(`[冒烟] 进程输出尾部：\n${output.join("").slice(-4000)}`);
    throw error;
  } finally {
    try {
      if (!readSpawnError())
        await stopChild(child).catch((error) => {
          console.error(
            `[冒烟] 停机输出尾部：\n${output.join("").slice(-4000)}`,
          );
          throw error;
        });
    } finally {
      stopDatabase(dataDir);
    }
  }
}

async function prepareDataLocationSmoke(source) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kenfutwork-location-smoke-")),
  );
  const paths = {
    root,
    configDir: join(root, "config"),
    pointerFile: join(root, "config", "data-location.json"),
    externalDir: join(root, "external-code"),
    blockedDir: join(root, "blocked-data"),
    movedDir: join(root, "moved-data"),
    backupDir: join(root, "offline-backup"),
    restoredDir: join(root, "restored-data"),
  };
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.externalDir);
  await mkdir(paths.blockedDir);
  await writeFile(
    paths.pointerFile,
    `${JSON.stringify({ dataDir: source })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    join(paths.externalDir, "external-context.txt"),
    "EXTERNAL_CODE_STAYS_IN_PLACE\n",
  );
  await writeFile(
    join(paths.blockedDir, "sentinel.txt"),
    "NONEMPTY_TARGET_MUST_NOT_CHANGE\n",
  );
  log(`独占配置、外部目录、移动与备份恢复根：${root}`);
  return paths;
}

async function stoppedRootManifest(root) {
  requireCondition(
    !existsSync(join(root, "postgres", "postmaster.pid")),
    "未确认PG停机，拒绝复制或计算备份基线。",
  );
  const entries = [];
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name);
      const info = await lstat(file);
      const path = relative(root, file);
      if (info.isDirectory()) {
        entries.push([path, "directory"]);
        await visit(file);
      } else if (info.isSymbolicLink())
        entries.push([path, "symlink", await readlink(file)]);
      else {
        requireCondition(info.isFile(), "停机目录中存在不可备份的运行时对象。");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        entries.push([path, "file", hash.digest("hex")]);
      }
    }
  };
  await visit(root);
  return JSON.stringify(entries);
}

async function runPackagedDataMove(packaged, source, target, pointerFile) {
  return new Promise((done, reject) => {
    const child = spawn(
      packaged.command,
      [
        ...packaged.args,
        "--move-data-location",
        JSON.stringify({ source, target, pointerFile }),
      ],
      {
        cwd: RELEASE,
        env: smokeOsEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("打包离线移动命令超时，保留全部目录。"));
    }, SMOKE_BYOK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // 离线命令不会启动PG或派生持管道后台进程；close确保最终JSON已完整读完。
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

function requireSuccessfulDataMove(result, target) {
  requireCondition(
    result.code === 0,
    "打包离线移动命令失败，源目录与配置保留。",
  );
  const payload = result.stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .findLast((value) => typeof value?.dataDir === "string");
  requireCondition(
    payload?.dataDir === target && payload.files > 0,
    "打包离线移动没有返回实际校验目标与文件数量。",
  );
}

function byokCallCounts(upstream) {
  const calls = upstream.calls;
  return JSON.stringify({
    chat: calls.chat.length,
    images: calls.images.length,
    downloads: calls.downloads,
    videoSubmit: calls.videoSubmit.length,
    videoPoll: calls.videoPoll,
    videoDownloads: calls.videoDownloads,
  });
}

async function verifyRestoredTaskAndKeys(base, dataDir, headers, fixture) {
  const scopeRoot = join(dataDir, "sandbox", "byok-smoke-code");
  const project = JSON.parse(
    (
      await expectStatus(base, `/api/projects/${fixture.task.projectId}`, 200, {
        headers,
      })
    ).body,
  ).project;
  requireCondition(
    project.work_dir === scopeRoot && project.kind === "code",
    "管理Code目录没有绑定到新数据根。",
  );
  const snapshot = JSON.parse(
    (
      await expectStatus(
        base,
        `/api/code-ui/sessions/${fixture.task.sessionId}`,
        200,
        { headers },
      )
    ).body,
  ).snapshot;
  requireCompletedByokSnapshot(snapshot);
  requireCondition(
    JSON.stringify(
      snapshot.rows.window
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.turnId),
    ) === JSON.stringify(fixture.task.initialTurnIds),
    "重启重放了原Code Run或改变了持久Run身份。",
  );
  requireCondition(
    (await readFile(join(scopeRoot, SMOKE_TOOL_FILE), "utf8")) ===
      SMOKE_TOOL_CONTENT,
    "管理Code文件没有恢复到新根。",
  );
  await requireNativeSmokeCheckpoints(
    base,
    headers,
    fixture.task.sessionId,
    fixture.task.projectId,
    scopeRoot,
    fixture.task.checkpointIds,
  );
  const shadow = join(
    dataDir,
    "checkpoints",
    fixture.instanceId,
    fixture.task.projectId,
    `${fixture.task.sessionId}.git`,
    createHash("sha256").update(scopeRoot).digest("hex"),
  );
  requireCondition(
    existsSync(join(shadow, "config")),
    "真实检查点影子仓库未按新Task根重新绑定hash目录。",
  );
  const keys = JSON.parse(
    await readFile(join(dataDir, "credentials", "byok.json"), "utf8"),
  );
  requireCondition(
    keys[fixture.providerId] === SMOKE_BYOK_KEY &&
      keys[fixture.video.providerId] === SMOKE_BYOK_KEY,
    "移动/恢复改变了明文BYOK Key或供应商身份。",
  );
}

async function verifyRestoredArtifacts(base, dataDir, headers, fixture) {
  for (const [assetId, objectPath, bytes] of [
    [fixture.images.directAssetId, undefined, SMOKE_IMAGE_BYTES],
    [
      fixture.images.imageAssetId,
      fixture.images.imageObjectPath,
      SMOKE_IMAGE_BYTES,
    ],
    [fixture.video.assetId, fixture.video.objectPath, SMOKE_VIDEO_BYTES],
  ]) {
    const asset = JSON.parse(
      (
        await expectStatus(base, `/api/uploads/${assetId}/url`, 200, {
          headers,
        })
      ).body,
    );
    await verifyByokStoredArtifact(
      base,
      dataDir,
      headers,
      asset.url,
      assetId,
      objectPath,
      bytes,
    );
  }
  for (const jobId of [fixture.images.imageJobId, fixture.video.jobId]) {
    const job = JSON.parse(
      (await expectStatus(base, `/api/jobs/${jobId}`, 200, { headers })).body,
    ).job;
    requireCondition(
      job.status === "succeeded" && job.session_id === fixture.task.sessionId,
      "备份恢复没有保留原后台job终态与Task上下文。",
    );
  }
}

async function verifyRestoredExternalTask(base, headers, fixture) {
  const external = fixture.external;
  const project = JSON.parse(
    (
      await expectStatus(base, `/api/projects/${external.projectId}`, 200, {
        headers,
      })
    ).body,
  ).project;
  requireCondition(
    project.work_dir === external.workspacePath &&
      (await readFile(
        join(external.workspacePath, "external-context.txt"),
        "utf8",
      )) === "EXTERNAL_CODE_STAYS_IN_PLACE\n",
    "外部项目目录或文件被数据根操作移动/修改。",
  );
  // 空Task按原UI规则不进入消息列表；通过公开的可信执行作用域核对持久归属。
  const scope = JSON.parse(
    (
      await expectStatus(
        base,
        `/api/code-ui/tasks/${external.sessionId}/scope`,
        200,
        { headers },
      )
    ).body,
  ).scope;
  requireCondition(
    scope.taskId === external.sessionId &&
      scope.projectId === external.projectId &&
      scope.rootDirectory === external.workspacePath,
    "外部Task没有保持原目录与持久身份。",
  );
}

async function verifyRestoredSmokeContext(base, dataDir, fixture, upstream) {
  requireCondition(
    byokCallCounts(upstream) === fixture.callCounts,
    "启动期间自动重放了旧模型/生成任务。",
  );
  const { desktop, desktopHeaders } = await readDesktopContext(base, dataDir);
  requireCondition(
    desktop.instanceId === fixture.instanceId,
    "移动/恢复生成了新的本地实例身份。",
  );
  await verifyRestoredTaskAndKeys(base, dataDir, desktopHeaders, fixture);
  await verifyRestoredArtifacts(base, dataDir, desktopHeaders, fixture);
  const stream = await openByokCodeStream(base, desktopHeaders);
  try {
    await verifyRestoredExternalTask(base, desktopHeaders, fixture);
    const view = await byokRpc(
      base,
      desktopHeaders,
      stream.ready.hello.connectionId,
      "providerSettingsService",
      "getView",
    );
    requireCondition(
      view.result.providers.find(
        (entry) => entry.providerId === fixture.providerId,
      )?.effectiveConfig.access?.apiKey === SMOKE_BYOK_KEY,
      "新根的授权设置没有读取到原供应商Key。",
    );
  } finally {
    await stream.close();
  }
  requireCondition(
    byokCallCounts(upstream) === fixture.callCounts,
    "单纯重启或读取恢复上下文自动重放了旧模型/生成任务。",
  );
  return desktopHeaders;
}

async function verifyFailedDataMove(
  packaged,
  source,
  paths,
  fixture,
  upstream,
  port,
  base,
) {
  const before = await stoppedRootManifest(source);
  const pointer = await readFile(paths.pointerFile, "utf8");
  const failed = await runPackagedDataMove(
    packaged,
    source,
    paths.blockedDir,
    paths.pointerFile,
  );
  requireCondition(
    failed.code !== 0 &&
      /目标数据目录必须不存在或为空目录/u.test(failed.stderr),
    "打包入口没有拒绝非空移动目标。",
  );
  requireCondition(
    (await stoppedRootManifest(source)) === before &&
      (await readFile(paths.pointerFile, "utf8")) === pointer,
    "移动失败修改了源数据或原配置指针。",
  );
  requireCondition(
    (await readFile(join(paths.blockedDir, "sentinel.txt"), "utf8")) ===
      "NONEMPTY_TARGET_MUST_NOT_CHANGE\n",
    "非空目标被移动命令覆盖。",
  );
  await withPackagedSmokeRuntime(
    packaged,
    source,
    port,
    base,
    paths.configDir,
    () => verifyRestoredSmokeContext(base, source, fixture, upstream),
  );
  log(
    "✓ 真实打包移动拒绝非空目标，源/目标/配置保留，原根可重新启动且不重放任务",
  );
}

async function verifySuccessfulDataMove(
  packaged,
  source,
  paths,
  fixture,
  upstream,
  port,
  base,
) {
  const before = await stoppedRootManifest(source);
  const moved = await runPackagedDataMove(
    packaged,
    source,
    paths.movedDir,
    paths.pointerFile,
  );
  requireSuccessfulDataMove(moved, paths.movedDir);
  requireCondition(
    (await stoppedRootManifest(source)) === before &&
      (await stoppedRootManifest(paths.movedDir)) === before,
    "实际移动没有保留源目录并生成逐文件一致的副本。",
  );
  requireCondition(
    JSON.parse(await readFile(paths.pointerFile, "utf8")).dataDir ===
      paths.movedDir,
    "实际移动未提交外部配置指针。",
  );
  await withPackagedSmokeRuntime(
    packaged,
    paths.movedDir,
    port,
    base,
    paths.configDir,
    () => verifyRestoredSmokeContext(base, paths.movedDir, fixture, upstream),
  );
  requireCondition(
    (await stoppedRootManifest(source)) === before,
    "新根启动回写了已保留的原数据根。",
  );
  log(
    "✓ 打包入口复制校验并切指针，新根保持同一实例/Task/Run/Key/资产，外部Code目录不移动",
  );
}

async function continueRestoredCodeConversation(
  base,
  dataDir,
  headers,
  fixture,
  upstream,
) {
  const stream = await openByokCodeStream(base, headers);
  const connectionId = stream.ready.hello.connectionId;
  const workspacePath = join(dataDir, "sandbox", "byok-smoke-code");
  const { projectId, sessionId, selection } = fixture.task;
  const chatBefore = upstream.calls.chat.length;
  try {
    await byokRpc(
      base,
      headers,
      connectionId,
      "zcodeAgentService",
      "subscribeConversationV4",
      [{ workspacePath, projectId, sessionId }],
    );
    const sent = await byokRpc(
      base,
      headers,
      connectionId,
      "zcodeAgentService",
      "sendConversationCommandV4",
      [
        {
          workspacePath,
          projectId,
          envelope: {
            commandId: randomUUID(),
            clientId: stream.clientId,
            sessionId,
            type: "sendText",
            issuedAt: Date.now(),
            payload: {
              text: `继续此前的会话。这是恢复后的新输入 ${SMOKE_RESUME_PROMPT}，不要调用工具。`,
              modelSelection: selection,
            },
          },
        },
      ],
    );
    requireCondition(
      sent.result.status === "accepted",
      "恢复后原Task没有接受新的原V4输入。",
    );
    const event = await waitForCompletedByokConversation(
      stream,
      SMOKE_RESUME_TEXT,
      "恢复后原Code会话的真实新Run",
    );
    requireCompletedByokSnapshot(
      codeSnapshotFromEvent(event),
      2,
      SMOKE_RESUME_TEXT,
    );
    const persisted = JSON.parse(
      (
        await expectStatus(base, `/api/code-ui/sessions/${sessionId}`, 200, {
          headers,
        })
      ).body,
    ).snapshot;
    requireCompletedByokSnapshot(persisted, 2, SMOKE_RESUME_TEXT);
    const turnIds = persisted.rows.window
      .filter((row) => row.kind === "turnHeader")
      .map((row) => row.turnId);
    requireCondition(
      fixture.task.initialTurnIds.every((id) => turnIds.includes(id)) &&
        new Set(turnIds).size === 2,
      "恢复后没有保留旧Run并追加一个新Run。",
    );
    const newCalls = upstream.calls.chat.slice(chatBefore);
    requireCondition(
      newCalls.some(
        (call) =>
          JSON.stringify(call.messages).includes(SMOKE_RESUME_PROMPT) &&
          call.messages.some(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message.content).includes(SMOKE_CHAT_TEXT),
          ),
      ),
      "恢复后的实际模型请求没有包含旧助手上下文与新输入。",
    );
    requireCondition(
      upstream.calls.images.length === 2 &&
        upstream.calls.videoSubmit.length === 1 &&
        upstream.calls.failures.length === 0,
      "恢复续聊重放了旧生成任务或出现协议失败。",
    );
  } finally {
    await stream.close();
  }
  log(
    "✓ 停机备份恢复保留原Code上下文，原Task新Run看到旧助手历史，旧任务未自动重放",
  );
}

async function verifyStoppedBackupRestore(
  packaged,
  paths,
  fixture,
  upstream,
  port,
  base,
) {
  const before = await stoppedRootManifest(paths.movedDir);
  // 用户停机文件夹备份流程；只复制目录，不引入产品内置打包器。
  await cp(paths.movedDir, paths.backupDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  requireCondition(
    (await stoppedRootManifest(paths.backupDir)) === before,
    "停机文件夹备份与原目录内容不一致。",
  );
  const restored = await runPackagedDataMove(
    packaged,
    paths.backupDir,
    paths.restoredDir,
    paths.pointerFile,
  );
  requireSuccessfulDataMove(restored, paths.restoredDir);
  requireCondition(
    (await stoppedRootManifest(paths.backupDir)) === before &&
      (await stoppedRootManifest(paths.restoredDir)) === before,
    "备份到恢复根的复制不一致或覆盖了备份。",
  );
  await withPackagedSmokeRuntime(
    packaged,
    paths.restoredDir,
    port,
    base,
    paths.configDir,
    async () => {
      const headers = await verifyRestoredSmokeContext(
        base,
        paths.restoredDir,
        fixture,
        upstream,
      );
      await continueRestoredCodeConversation(
        base,
        paths.restoredDir,
        headers,
        fixture,
        upstream,
      );
    },
  );
  requireCondition(
    (await stoppedRootManifest(paths.backupDir)) === before &&
      (await stoppedRootManifest(paths.movedDir)) === before,
    "恢复根运行回写了停机备份或保留的移动源。",
  );
}

async function verifyDataLocationLifecycle(
  packaged,
  source,
  paths,
  fixture,
  upstream,
  port,
  base,
) {
  fixture.callCounts = byokCallCounts(upstream);
  await verifyFailedDataMove(
    packaged,
    source,
    paths,
    fixture,
    upstream,
    port,
    base,
  );
  await verifySuccessfulDataMove(
    packaged,
    source,
    paths,
    fixture,
    upstream,
    port,
    base,
  );
  await verifyStoppedBackupRestore(
    packaged,
    paths,
    fixture,
    upstream,
    port,
    base,
  );
}

async function main() {
  const packaged = packagedCommand();
  const dataDir = await prepareSmokeDataDir(packaged);
  const locations = await prepareDataLocationSmoke(dataDir);
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  log(`产物：${packaged.command}`);
  log(`独占数据目录：${dataDir}`);
  log(`端口：${port}`);
  const upstream = await createByokProtocolUpstream();
  try {
    log("启动打包服务端（首次初始化最多等待 120 秒）…");
    const fixture = await withPackagedSmokeRuntime(
      packaged,
      dataDir,
      port,
      base,
      locations.configDir,
      async () => {
        log("✓ 服务就绪，离线首页托管正常");
        const desktopHeaders = await verifyLocalAccess(base, dataDir);
        return verifyByokPipeline(
          base,
          dataDir,
          desktopHeaders,
          upstream,
          locations.externalDir,
        );
      },
    );
    await verifyDataLocationLifecycle(
      packaged,
      dataDir,
      locations,
      fixture,
      upstream,
      port,
      base,
    );
  } finally {
    await upstream.close();
  }
  if (!keepData) {
    await rm(dataDir, { force: true, recursive: true });
    await rm(locations.root, { force: true, recursive: true });
  }
  log("✓ 服务端与内嵌数据库均已停止");
  log(
    "结论：真实桌面产物完成免账户/BYOK协议、停机移动失败保源、目录备份恢复与原Code会话继续；未调用外部付费供应商。",
  );
}

void main().catch((error) => {
  console.error(
    `[冒烟] ✗ ${error instanceof Error ? error.message : "冒烟失败。"}`,
  );
  process.exitCode = 1;
});
