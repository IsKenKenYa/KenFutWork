/**
 * 仓外冷启动：把 release/ 复制到一个与仓库无祖先关系的新目录，用**发布产物本体**
 * （macOS: 随包 node + server.cjs；Windows: KenFutWork-server.exe）在那里启动。
 *
 * 为什么必须复制而不是换 cwd：原生外部依赖（@napi-rs/canvas、node-pty、@vscode/ripgrep）
 * 是按 `server.cjs` 的路径向上找 `node_modules` 的。产物留在仓库里时，向上走会撞见仓库
 * 自己的 `node_modules`，于是「开发机能跑」和「装机后能跑」被混为一谈——本机实测过一次
 * `Cannot find module '@napi-rs/canvas'` → pdfjs 缺 DOMMatrix → 服务端启动即崩。
 *
 *   node scripts/packaged-outside-repo-cold-start.mjs
 *
 * 不访问外部模型服务，不读用户凭据；只验「起得来 + 本机凭据边界仍在」。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RELEASE = join(resolve(import.meta.dirname, ".."), "release");
/** 复制时排除的顶层项：上一轮冒烟留下的日志，不是产物。 */
const SKIP = new Set(["smoke-server.log"]);

function log(message) {
  console.log(`[仓外冷启动] ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function packagedArtifacts(destination) {
  if (process.platform === "win32")
    return { command: join(destination, "KenFutWork-server.exe"), args: [] };
  requireCondition(
    process.platform === "darwin",
    "本检查只覆盖桌面发布产物（macOS / Windows）。",
  );
  return {
    command: join(destination, "runtime", "node", "bin", "node"),
    args: [join(destination, "server", "server.cjs")],
  };
}

function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolvePort(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

async function copyReleaseTree(destination) {
  await mkdir(destination, { recursive: true });
  // 逐顶层项复制：两平台布局不同（mac 有 runtime/，win 是单文件 exe），只挑存在的。
  for (const name of readdirSync(RELEASE)) {
    if (SKIP.has(name)) continue;
    await cp(join(RELEASE, name), join(destination, name), {
      recursive: true,
      dereference: true,
    });
  }
  return readdirSync(destination).sort();
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  return { status: response.status, body: await response.text() };
}

async function waitForReady(base, child, output) {
  const deadline = Date.now() + 180_000;
  let last = "未响应";
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `服务端在就绪前退出（code ${child.exitCode}，最后一次 ${last}）。\n输出尾部：\n${output.join("").slice(-4000)}`,
      );
    try {
      const { status, body } = await fetchJson(`${base}/api/health`);
      if (status === 200) {
        const payload = JSON.parse(body);
        requireCondition(
          payload.service === "kenfutwork-server",
          `service 名不符：${payload.service}`,
        );
        return;
      }
      last = String(status);
    } catch {
      // 启动期连不上是预期内的；进程是否还活着才是判据。
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`180 秒内 /api/health 未就绪（最后一次 ${last}）。`);
}

/** 与打包冒烟同一口径：只继承 OS 运行所需环境，不带本机供应商/数据库配置。 */
function osEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|HOME|USER|LOGNAME|TMPDIR|TEMP|TMP|SYSTEMROOT|SystemRoot|COMSPEC|ComSpec|PATHEXT|LANG|LC_ALL|APPDATA|LOCALAPPDATA)$/.test(
        name,
      ),
    ),
  );
}

/**
 * 停干净整个运行时再交还目录：SIGTERM 等退出、超时 SIGKILL 兜底，随后用产物自带的
 * pg_ctl 显式停掉内嵌 PG 并**确认已停**（杀掉父进程不会带走它派生的 postgres——
 * Windows 上句柄不释放，rmSync 直接 EPERM，实测 38030977516）。与冒烟的
 * stopChild/stopDatabase 同一序列、同一确认强度。
 */
async function stopRuntime(child, destination, dataDir) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => {
      const timer = setTimeout(() => done(false), 20_000);
      child.once("exit", () => {
        clearTimeout(timer);
        done(true);
      });
    });
    child.kill("SIGTERM");
    if (!(await exited)) child.kill("SIGKILL");
  }
  const pgDataDir = join(dataDir, "postgres");
  if (!existsSync(join(pgDataDir, "PG_VERSION"))) return;
  const pgCtl = join(
    destination,
    "pg",
    "bin",
    process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
  );
  const status = () =>
    spawnSync(pgCtl, ["-D", pgDataDir, "status"], { stdio: "ignore" });
  const initial = status();
  requireCondition(!initial.error, "无法检查内嵌数据库是否已停止。");
  if (initial.status === 0) {
    const stopped = spawnSync(
      pgCtl,
      ["-D", pgDataDir, "-m", "fast", "-w", "stop"],
      { stdio: "ignore" },
    );
    requireCondition(stopped.status === 0, "内嵌数据库关停失败。");
  }
  const final = status();
  requireCondition(
    !final.error && final.status === 3,
    "内嵌数据库未确认停止。",
  );
}

async function main() {
  requireCondition(
    existsSync(RELEASE),
    `找不到打包产物目录：${RELEASE}（先跑 package-mac/package-win）。`,
  );
  const sandboxRoot = await mkdtemp(join(tmpdir(), "kfw-outside-repo-"));
  const destination = join(sandboxRoot, "release");
  const entries = await copyReleaseTree(destination);
  const packaged = packagedArtifacts(destination);
  requireCondition(
    existsSync(packaged.command),
    `复制后的产物里没有可执行服务端：${packaged.command}`,
  );
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  log(`目标根（与仓库无祖先关系）：${sandboxRoot}`);
  log(`顶层条目（${entries.length}）：${entries.join(", ")}`);
  log(`启动 ${packaged.command}`);
  const child = spawn(packaged.command, packaged.args, {
    // cwd 同样落在仓外：连「靠仓库 cwd 蒙对路径」这条路也堵掉。
    cwd: sandboxRoot,
    env: {
      ...osEnvironment(),
      TMPDIR: sandboxRoot,
      HOST: "127.0.0.1",
      KENFUTWORK_DATA_DIR: join(sandboxRoot, "data"),
      KENFUTWORK_EMBEDDED_PG: "1",
      KENFUTWORK_QUEUE_DRIVER: "in-process",
      KENFUTWORK_SERVER_PORT: String(port),
      KENFUTWORK_WEB_DIST: join(destination, "web"),
      KENFUTWORK_WEB_ORIGIN: base,
      KENFUTWORK_BLOB_PUBLIC_BASE_URL: `${base}/api/blobs`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  try {
    await waitForReady(base, child, output);
    writeFileSync(join(sandboxRoot, "server.log"), output.join(""), "utf8");
    log("✓ /api/health 200 且 service 名正确");
    for (const route of ["/api/projects?kind=code", "/api/models"]) {
      const { status } = await fetchJson(`${base}${route}`);
      requireCondition(
        status === 401,
        `${route} 无凭据时返回 ${status}（应为 401）`,
      );
      log(`✓ ${route} 无凭据 → 401（本机凭据边界在仓外同样生效）`);
    }
    log("✓ 发布产物不依赖仓库树");
  } catch (error) {
    // 失败时把服务端原始输出打出来：这条 job 的红必须是代码的红。
    console.error(
      `[仓外冷启动] ✗ ${error.message}\n完整输出（${output.join("").length} 字符）：\n${output.join("")}`,
    );
    throw error;
  } finally {
    // 先停干净进程与内嵌 PG，再删临时根；retryDelay 给足余量吸收 Windows
    // Defender 对新落盘 exe 的短时句柄（默认 100ms 三次不够，实测）。
    await stopRuntime(child, destination, join(sandboxRoot, "data"));
    rmSync(sandboxRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
}

await main();
