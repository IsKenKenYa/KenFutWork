import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
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

async function ownedRuntimePids(app: string) {
  const prefix = join(app, "Contents", "Resources", "app");
  const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,args="]);
  return stdout.split("\n").flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!row) return [];
    const args = row[2] ?? "";
    return args.startsWith(
      join(prefix, "runtime", "node", "bin", "node") + " ",
    ) || args.startsWith(join(prefix, "pg", "bin", "postgres") + " ")
      ? [Number(row[1])]
      : [];
  });
}

// LaunchServices启动实际签名.app；独占安装/数据目录，原公开Task/RPC与模型HTTP，不替换内核。
it.skipIf(!enabled)(
  "实际macOS.app通过持久Task/HTTP MCP控制窗口并确认TCC与PNG/Unicode",
  async () => {
    const retainedRoot = process.env.KENFUTWORK_TEST_APP_ROOT;
    const root = retainedRoot
      ? await realpath(retainedRoot)
      : await realpath(await mkdtemp(join(tmpdir(), "kfw-cua-app-")));
    const marker = join(root, "验收所属.json");
    if (retainedRoot) {
      if (
        dirname(root) !== (await realpath(tmpdir())) ||
        !basename(root).startsWith("kfw-cua-app-")
      )
        throw new Error("只允许复用本验收创建的临时安装目录。");
      z.object({
        purpose: z.literal("computer-use-app-native"),
        root: z.literal(root),
      }).parse(JSON.parse(await readFile(marker, "utf8")));
    } else {
      await writeFile(
        marker,
        JSON.stringify({ purpose: "computer-use-app-native", root }),
      );
    }
    const installedApp = join(root, "安装", "KenFutWork.app");
    const sourceApp = fileURLToPath(
      new URL(
        "../../../../desktop/src-tauri/target/release/bundle/macos/KenFutWork.app/",
        import.meta.url,
      ),
    );
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
      throw new Error("该验收副本仍在运行；请关闭后再复验，不接管既有进程。");
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
      if (!retainedRoot) {
        await mkdir(join(root, "安装"));
        await cp(sourceApp, installedApp, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
      }
      console.info("实际.app：独立安装副本已就绪");
      await exec("codesign", ["--verify", "--deep", "--strict", installedApp]);
      await exec("open", [
        "-n",
        installedApp,
        "--env",
        `KENFUTWORK_DATA_DIR=${data}`,
      ]);
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
              port = Number(log.match(/拉起随包服务端：.*（端口 (\d+)，/)?.[1]);
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
      // 临时安装/数据与日志保留本机供失败审计；不覆盖或移除用户的数据。
      console.info(`实际.app验收资源：${root}`);
    }
    if (failures.length)
      throw new AggregateError(failures, "实际.app验收或正常退出验证失败");
  },
  AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
);
