import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCodeUiTestClient } from "../code-ui/host-client.fixture.js";
import { createCodeSessionFixture } from "../code-ui/host-session.fixture.js";
import { adaptSdkTransport } from "../mcp/sdk-transport.js";
import { createDesktopModelServer } from "./fixtures/model-server.js";
import { CU_BUNDLE_ID, CU_TOOL_PREFIX } from "./tools.js";

const exec = promisify(execFile);
const enabled =
  process.platform === "darwin" && process.env.KENFUTWORK_TEST_DESKTOP === "1";

async function ownedAppPid(executable: string) {
  const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,comm="]);
  const match = stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .find((row) => row?.[2] === executable);
  return match ? Number(match[1]) : undefined;
}

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const fixedApp = join(repo, "KenFutWork.app");
let development: ReturnType<typeof spawn> | undefined;
const knownRuntimePids = new Set<number>();
let developmentOutput = "";

function launchFixedApp(data: string) {
  developmentOutput = "";
  knownRuntimePids.clear();
  const child = spawn("bash", ["apps/desktop/dev.sh"], {
    cwd: repo,
    env: {
      ...process.env,
      KENFUTWORK_DATA_DIR: data,
      KENFUTWORK_CONFIG_DIR: join(data, "..", "config"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  development = child;
  const log = createWriteStream(join(data, "desktop-development.log"));
  for (const stream of [child.stdout, child.stderr]) {
    stream.pipe(log, { end: false });
    stream.on("data", (chunk) => {
      developmentOutput = (developmentOutput + String(chunk)).slice(-65536);
    });
  }
  development.once("close", () => log.end());
}

async function ownedRuntimePids(app: string) {
  const executable = join(app, "Contents/MacOS/kenfutwork-desktop");
  const appPid = await ownedAppPid(executable);
  const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,ppid=,args="]);
  const rows = stdout.split("\n").flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]) }] : [];
  });
  const roots = new Set(
    [appPid, development?.pid].filter((pid): pid is number => !!pid),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows)
      if (roots.has(row.parent) && !roots.has(row.pid)) {
        roots.add(row.pid);
        knownRuntimePids.add(row.pid);
        changed = true;
      }
  }
  return rows
    .filter((row) => knownRuntimePids.has(row.pid))
    .map((row) => row.pid);
}

async function browserConnected(data: string) {
  const lines = (
    await readFile(join(data, "logs/server-spawn.log"), "utf8")
  ).split("\n");
  const ticketRequests = new Set<string>();
  for (const line of lines) {
    let event: {
      req?: { url?: string };
      reqId?: string;
      res?: { statusCode: number };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event.reqId) continue;
    if (event.req?.url === "/api/local-access/connect")
      ticketRequests.add(event.reqId);
    // 只有真正WebView消费票据才会走connect；壳只签发tickets，Bearer夹具不走这里。
    const statusCode = event.res?.statusCode;
    if (
      ticketRequests.has(event.reqId) &&
      statusCode !== undefined &&
      statusCode >= 200 &&
      statusCode < 300
    )
      return true;
  }
  return false;
}

async function assertActualAppNormalExit(
  app: string,
  executable: string,
  data: string,
) {
  launchFixedApp(data);
  let pid: number | undefined;
  await expect
    .poll(
      async () => {
        pid = await ownedAppPid(executable);
        try {
          const log = await readFile(join(data, "desktop-shell.log"), "utf8");
          if (log.includes("复用") || log.includes("启动失败"))
            throw new Error(log);
          return !!pid && log.includes("服务端已拉起（pid ");
        } catch (error) {
          if (error instanceof Error && /复用|启动失败/.test(error.message))
            throw error;
          return false;
        }
      },
      { timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs },
    )
    .toBe(true);
  if (!pid) throw new Error("正常启动验收未找到所属应用。");
  await expect
    .poll(() => browserConnected(data), { timeout: 20_000 })
    .toBe(true);
  process.kill(pid, "SIGTERM");
  await expect
    .poll(() => ownedAppPid(executable), {
      timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
    })
    .toBeUndefined();
  await expect
    .poll(() => ownedRuntimePids(app), {
      timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
    })
    .toEqual([]);
}

it.skipIf(!enabled)(
  "固定源码应用的WebView真实换票并在热更新后保持应用签名",
  async () => {
    const root = await mkdtemp(
      join(repo, ".kenfutwork-data", "computer-use-hot-reload-"),
    );
    const data = join(root, "data");
    await mkdir(data);
    const executable = join(fixedApp, "Contents/MacOS/kenfutwork-desktop");
    if (await ownedAppPid(executable))
      throw new Error("固定应用正在运行，拒绝接管。");
    const binaryHash = async () =>
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
    const before = await binaryHash();
    let pid: number | undefined;
    const serverPid = async () => {
      const owned = await ownedRuntimePids(fixedApp);
      const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,args="]);
      const row = stdout
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
        .find(
          (row) =>
            row &&
            owned.includes(Number(row[1])) &&
            row[2]?.includes("--import tsx ./src/server.ts") &&
            !row[2]?.includes("--watch"),
        );
      return row ? Number(row[1]) : undefined;
    };
    let success = false;
    try {
      launchFixedApp(data);
      await expect
        .poll(
          async () => {
            pid = await ownedAppPid(executable);
            return (
              !!pid &&
              (await browserConnected(data).catch((error) => {
                if (error.code === "ENOENT") return false;
                throw error;
              }))
            );
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      const oldServer = await serverPid();
      expect(oldServer).toBeTypeOf("number");
      // 只触发源码watcher，文件内容不变，应用也不重建。
      const now = new Date();
      await utimes(
        join(
          repo,
          "apps/server/src/features/computer-use/permission-status-rpc.ts",
        ),
        now,
        now,
      );
      await expect
        .poll(
          async () => {
            const next = await serverPid();
            return next !== undefined && next !== oldServer;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(await ownedAppPid(executable)).toBe(pid);
      expect(await binaryHash()).toBe(before);
      await exec("codesign", ["--verify", "--deep", "--strict", fixedApp]);
      success = true;
    } finally {
      await ownedRuntimePids(fixedApp);
      if (pid && (await ownedAppPid(executable)) === pid)
        process.kill(pid, "SIGTERM");
      development?.kill("SIGTERM");
      await expect
        .poll(() => ownedRuntimePids(fixedApp), { timeout: 30_000 })
        .toEqual([]);
      await expect
        .poll(() => ownedAppPid(executable), { timeout: 30_000 })
        .toBeUndefined();
      if (success) await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

// 固定签名.app通过pnpm desktop拥有源码API；数据隔离，原公开Task/RPC与模型HTTP。
it.skipIf(!enabled)(
  "实际macOS.app通过持久Task/HTTP MCP控制窗口并确认TCC与PNG/Unicode",
  async () => {
    const evidenceDir = join(repo, ".kenfutwork-data");
    await mkdir(evidenceDir, { recursive: true });
    const root = await mkdtemp(join(evidenceDir, "computer-use-app-"));
    const installedApp = fixedApp;
    const executable = join(
      installedApp,
      "Contents",
      "MacOS",
      "kenfutwork-desktop",
    );
    const data = await mkdtemp(join(root, "数据-"));
    if (
      (await ownedAppPid(executable)) ||
      (await ownedRuntimePids(installedApp)).length
    )
      throw new Error("固定应用仍在运行；请关闭后再复验，不接管既有进程。");
    let appPid: number | undefined;
    let fixture: ReturnType<typeof spawn> | undefined;
    let model: Awaited<ReturnType<typeof createDesktopModelServer>> | undefined;
    let transport: ReturnType<typeof createCodeUiTestClient> | undefined;
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    let mcp: Client | undefined;
    let resumeModel = () => {};
    let modelStarted = () => {};
    const failures: unknown[] = [];
    const firstRequest = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resumeModel = resolve;
    });
    try {
      console.info("实际.app：复用仓库根目录固定开发应用，不复制安装包");
      await exec("codesign", ["--verify", "--deep", "--strict", installedApp]);
      launchFixedApp(data);
      await expect
        .poll(() => ownedAppPid(executable), {
          timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs,
        })
        .toBeTypeOf("number");
      appPid = await ownedAppPid(executable);
      if (!appPid) throw new Error("LaunchServices未启动测试所属.app");
      const logPath = join(data, "desktop-shell.log");
      let port = 0;
      await expect
        .poll(
          async () => {
            try {
              const log = await readFile(logPath, "utf8");
              if (log.includes("复用"))
                throw new Error("测试.app复用了既有服务，拒绝访问其数据");
              if (log.includes("启动失败")) throw new Error(log);
              port = Number(developmentOutput.match(/（API (\d+)，Web/)?.[1]);
              // HTTP健康早于壳持有ServerHandle；必须等实际壳完成启动，不抢先结束它。
              if (!port || !log.includes("服务端已拉起（pid ")) return false;
              return (
                (await fetch(`http://127.0.0.1:${port}/api/health`)).status ===
                200
              );
            } catch (error) {
              if (error instanceof Error && /复用|启动失败/.test(error.message))
                throw error;
              return false;
            }
          },
          { timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs },
        )
        .toBe(true);
      const base = `http://127.0.0.1:${port}`;
      await expect
        .poll(() => browserConnected(data), { timeout: 20_000 })
        .toBe(true);
      console.info("实际.app：壳已持有自有服务，开始公开安装与Task流程");
      const token = (
        await readFile(join(data, "local-access", "desktop-token"), "utf8")
      ).trim();
      const headers = { authorization: `Bearer ${token}` };
      transport = createCodeUiTestClient({
        baseUrl: base,
        origin: base,
        headers,
      });
      const installation = await transport.request("/api/plugins/install", {
        builtin: CU_BUNDLE_ID,
        allowLifecycleScripts: false,
      });
      expect(installation.status, JSON.stringify(installation.body)).toBe(201);
      console.info("实际.app：自带Computer Use插件已通过公开API安装");
      const probe = join(root, "desktop-probe");
      await exec("swiftc", [
        fileURLToPath(new URL("./fixtures/desktop.swift", import.meta.url)),
        "-module-cache-path",
        join(root, "swift-cache"),
        "-o",
        probe,
      ]);
      fixture = spawn(probe, [], { stdio: ["pipe", "pipe", "pipe"] });
      await once(fixture.stdout!, "data");
      model = await createDesktopModelServer(fixture.pid!, {
        beforeResponse: async (stage) => {
          if (stage === 0) {
            modelStarted();
            await gate;
          }
        },
      });
      host = await createCodeSessionFixture(model.baseURL, {
        client: transport,
      });
      console.info("实际.app：原公开RPC已创建持久Task与模型配置");
      const icon = await transport.request("/api/code-ui/rpc", {
        connectionId: host.stream.ready.hello.connectionId,
        service: "platform",
        method: "getApplicationIcon",
        args: [
          {
            locators: [{ kind: "darwin-bundle-id", value: "com.apple.finder" }],
          },
        ],
      });
      expect(icon.status, JSON.stringify(icon.body)).toBe(200);
      const iconUrl = z
        .string()
        .startsWith("data:image/png;base64,")
        .parse(icon.body.result.iconDataUrl);
      const iconPng = PNG.sync.read(
        Buffer.from(iconUrl.slice("data:image/png;base64,".length), "base64"),
      );
      expect([iconPng.width, iconPng.height]).toEqual([32, 32]);
      console.info("实际.app：原RPC系统图标32×32已验证");
      const idle = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        (
          await host.command(
            "switchCollaborationMode",
            { mode: "yolo" },
            undefined,
            { baseRevision: idle.revision, baseLogEpoch: idle.logEpoch },
          )
        ).status,
      ).toBe(200);
      const started = await host.command("sendText", {
        text: "观察第一方验收窗口，截屏并输入Task中文🙂🚀。",
        modelSelection: idle.config.modelSelection,
        mode: "yolo",
        planEnabled: false,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      await firstRequest;
      const running = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const runId = running.control.activeWorks[0]?.foregroundExecutionId;
      if (!runId) throw new Error("实际.app未生成真实持久Task Run");
      mcp = new Client({ name: "signed-app-native-consumer", version: "test" });
      const http = new StreamableHTTPClientTransport(
        new URL(
          `/api/computer-use/mcp?runId=${encodeURIComponent(runId)}`,
          base,
        ),
        { requestInit: { headers } },
      );
      await mcp.connect(adaptSdkTransport(http));
      const access = CallToolResultSchema.parse(
        await mcp.callTool({ name: "request_access", arguments: {} }),
      );
      expect(access.isError, JSON.stringify(access.structuredContent)).not.toBe(
        true,
      );
      expect(
        access.structuredContent,
        JSON.stringify(access.structuredContent),
      ).toMatchObject({
        permissionStatus: {
          accessibility: "granted",
          screen: "granted",
          postEvents: "granted",
        },
      });
      resumeModel();
      const currentHost = host;
      await expect
        .poll(
          async () =>
            protocol.conversationSnapshotSchema.parse(
              await currentHost.snapshot(),
            ).control.phase,
          { timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs * 2 },
        )
        .toBe("completedSuccess");
      const final = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const shot = final.rows.window.find(
        (row) =>
          row.kind === "toolCall" &&
          row.toolName === `${CU_TOOL_PREFIX}screenshot`,
      );
      if (
        !shot ||
        shot.kind !== "toolCall" ||
        shot.output?.display?.kind !== "cua"
      )
        throw new Error("实际.app原V4缺少真实CUA图片行");
      expect(
        shot.output.display.media?.some(
          (block) =>
            block.mimeType === "image/png" &&
            typeof block.data === "string" &&
            block.data.length > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(model.requests)).toContain(
        "data:image/png;base64,",
      );
      const messages = z
        .array(
          z.object({
            tool_call_id: z.string().optional(),
            content: z.unknown(),
          }),
        )
        .parse(model.requests.at(-1)?.messages);
      const observed = messages.find(
        (message) => message.tool_call_id === "desktop-model-5",
      );
      expect(JSON.stringify(observed?.content)).toContain("Task中文🙂🚀");
      expect(JSON.stringify(final).includes(token)).toBe(false);
      expect(
        (await readdir(join(data, "logs"))).some((name) =>
          name.startsWith("pipeline-"),
        ),
      ).toBe(true);
      await expect(
        mcp.callTool({
          name: "get_app_state",
          arguments: { app: { pid: fixture.pid } },
        }),
      ).rejects.toThrow(/MCP会话不存在或已结束/);
    } catch (error) {
      failures.push(error);
    } finally {
      resumeModel();
      const settle = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await settle(async () => mcp?.close());
      await settle(async () => host?.dispose());
      await settle(async () => transport?.close());
      await settle(async () => {
        if (fixture && fixture.exitCode === null) {
          fixture.kill();
          await once(fixture, "exit");
        }
      });
      await settle(async () => {
        appPid ??= await ownedAppPid(executable);
        if (!appPid) return;
        process.kill(appPid, "SIGTERM");
        await expect
          .poll(() => ownedAppPid(executable), {
            timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs,
          })
          .toBeUndefined();
      });
      await settle(async () => {
        await expect
          .poll(() => ownedRuntimePids(installedApp), {
            timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
          })
          .toEqual([]);
      });
      // 先保留正常退出断言失败，再回收精确测试路径；回收不能冒充正常退出通过。
      for (const pid of await ownedRuntimePids(installedApp)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await settle(async () => {
        await expect
          .poll(() => ownedRuntimePids(installedApp), {
            timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
          })
          .toEqual([]);
      });
      await settle(async () => model?.close());
      await settle(async () => {
        await exec("codesign", [
          "--verify",
          "--deep",
          "--strict",
          installedApp,
        ]);
      });
      development?.kill("SIGTERM");
      // 仅保留隔离数据/日志用于失败审计，应用始终为同一个固定路径。
      console.info(`实际.app验收资源：${root}`);
    }
    if (failures.length)
      throw new AggregateError(failures, "实际.app验收或正常退出验证失败");
  },
  AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
);

// 数据库暂停使壳停在启动中；退出前恢复，避免孤儿停止组的HUP/CONT替应用回收。
it.skipIf(!enabled)(
  "实际macOS.app在服务尚未就绪时退出也回收所属进程",
  async () => {
    const evidenceDir = join(repo, ".kenfutwork-data");
    await mkdir(evidenceDir, { recursive: true });
    const root = await mkdtemp(join(evidenceDir, "computer-use-early-exit-"));
    const app = fixedApp;
    if (await ownedAppPid(join(app, "Contents/MacOS/kenfutwork-desktop")))
      throw new Error("固定应用正在运行，拒绝接管已有进程。");
    const data = join(root, "数据");
    await mkdir(data);
    const executable = join(app, "Contents", "MacOS", "kenfutwork-desktop");
    let appPid: number | undefined;
    let stoppedPid: number | undefined;
    try {
      await exec("codesign", ["--verify", "--deep", "--strict", app]);
      launchFixedApp(data);
      await expect
        .poll(
          async () => {
            appPid = await ownedAppPid(executable);
            const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,args="]);
            const row = stdout
              .split("\n")
              .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
              .find(
                (entry) =>
                  entry?.[2]?.includes(data) && /\/postgres\s/u.test(entry[2]),
              );
            stoppedPid = row ? Number(row[1]) : undefined;
            return !!appPid && !!stoppedPid;
          },
          { interval: 10, timeout: AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs },
        )
        .toBe(true);
      if (!appPid || !stoppedPid) throw new Error("未启动本验收所属进程。");
      process.kill(stoppedPid, "SIGSTOP");
      const log = await readFile(join(data, "desktop-shell.log"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return ""; // 首条壳日志在就绪/失败时写，尚未就绪可以没有文件。
          throw error;
        },
      );
      expect(log).not.toContain("服务端已拉起（pid ");
      process.kill(stoppedPid, "SIGCONT");
      stoppedPid = undefined;
      process.kill(appPid, "SIGTERM");
      await expect
        .poll(() => ownedAppPid(executable), {
          timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
        })
        .toBeUndefined();
      await expect
        .poll(() => ownedRuntimePids(app), {
          timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
        })
        .toEqual([]);
      await assertActualAppNormalExit(
        app,
        executable,
        await mkdtemp(join(root, "正常启动-")),
      );
    } finally {
      // 失败后的精确回收只防污染，不算正常退出GREEN。
      if (stoppedPid && (await ownedRuntimePids(app)).includes(stoppedPid)) {
        try {
          process.kill(stoppedPid, "SIGCONT");
        } catch {}
      }
      const remainingApp = await ownedAppPid(executable);
      if (remainingApp) process.kill(remainingApp, "SIGTERM");
      for (const pid of await ownedRuntimePids(app)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await expect
        .poll(() => ownedRuntimePids(app), {
          timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
        })
        .toEqual([]);
      await exec("codesign", ["--verify", "--deep", "--strict", app]);
      development?.kill("SIGTERM");
      console.info(`实际.app早退验收资源：${root}`);
    }
  },
  AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
);
