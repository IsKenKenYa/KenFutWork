import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { ToolDeniedError } from "../../kernel/context.js";
import { createInstanceChatModel } from "../../providers/openai-compatible/index.js";
import { adaptSdkTransport } from "../mcp/sdk-transport.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createDesktopModelServer } from "./fixtures/model-server.js";
import { installedKernel, taskRuntime } from "./fixtures/task-agent.js";
import type { ComputerUseMcpExport } from "./mcp-server.js";
import { CU_TOOL_PREFIX } from "./tools.js";

const exec = promisify(execFile);
const enabled =
  process.platform === "darwin" && process.env.KENFUTWORK_TEST_DESKTOP === "1";

describe.skipIf(!enabled)("真实macOS Task→插件→Agent→模型HTTP→V4事件", () => {
  it.each(["内存", "HTTP"])(
    "%s出口的持久Task实际调用CUA，模型HTTP拿到PNG且原V4行保留结果",
    async (transportForm) => {
      const database = await createTaskWorkDatabase();
      let fixture: ReturnType<typeof spawn> | undefined;
      let installed: Awaited<ReturnType<typeof installedKernel>> | undefined;
      let task: Awaited<ReturnType<typeof taskRuntime>> | undefined;
      let modelServer:
        | Awaited<ReturnType<typeof createDesktopModelServer>>
        | undefined;
      let mcpClient: Client | undefined;
      let mcpServer: Server | undefined;
      let httpTransport: StreamableHTTPClientTransport | undefined;
      let httpOrigin: string | undefined;
      let otherHttpClient: Client | undefined;
      let nativeOutput = "";
      let testShiftHeld = false;
      let frozenWorker: number | undefined;
      let pumping: Promise<void> | undefined;
      let activeRunId: string | undefined;
      let resumeModel = () => {};
      let modelStarted!: () => void;
      const firstRequest = new Promise<void>((resolve) => {
        modelStarted = resolve;
      });
      const responseGate = new Promise<void>((resolve) => {
        resumeModel = resolve;
      });
      const events: StreamEvent[] = [];
      try {
        const executable = join(database.directory, "desktop-probe");
        await exec("swiftc", [
          new URL("./fixtures/desktop.swift", import.meta.url).pathname,
          "-module-cache-path",
          join(database.directory, "swift-cache"),
          "-o",
          executable,
        ]);
        fixture = spawn(executable, ["--noisy-background"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        await once(fixture.stdout!, "data");
        fixture.stdout!.on("data", (bytes) => {
          nativeOutput += String(bytes);
        });
        modelServer = await createDesktopModelServer(fixture.pid!, {
          screenshotRecovery: true,
          omitRole: true,
          beforeResponse: async (stage) => {
            if (stage === 0) {
              modelStarted();
              await responseGate;
            }
          },
        });
        const env = loadServerEnv({
          agentBackendMode: "filesystem",
          agentFilesRoot: database.directory,
          checkpointRoot: join(database.directory, "checkpoints"),
        });
        installed = await installedKernel(database, env);
        task = await taskRuntime(
          database,
          installed,
          env,
          createInstanceChatModel("desktop-fixture", {
            apiKey: "desktop-fixture",
            useResponsesApi: false,
            baseUrl: modelServer.baseURL,
          }),
        );
        const { runId } = task.runtime.createRun(
          {
            sessionId: task.scope.taskId,
            conversationId: task.scope.taskId,
            projectId: task.scope.projectId,
            taskId: task.scope.taskId,
            preset: "code",
            prompt: "观察验收窗口，截屏并输入Task中文🙂🚀。",
          },
          {
            threadId: task.threadId,
            scopeHandle: task.handle,
            actor: task.actor,
            eventSink: async (event) => {
              events.push(event);
              task!.host.recordEvent(event);
            },
          },
        );
        activeRunId = runId;
        await task.metadata().createAcceptedRun({
          runId,
          sessionId: task.scope.taskId,
          threadId: task.threadId,
        });
        task.host.startTurn({
          runId,
          commandId: "desktop-native-agent",
          text: "macOS真实Task",
        });
        pumping = (async () => {
          for await (const _event of task!.runtime.streamRun(runId)) {
            // 与CodeUI生产消费者相同：持久事件只从runtime的稳定eventSink进入原V4。
          }
        })();
        await Promise.race([
          firstRequest,
          pumping.then(() => {
            throw new Error("Run在进入模型HTTP前结束");
          }),
        ]);
        const exporter = installed.kernel
          .get("capabilities")
          .list<ComputerUseMcpExport>("computer-use-mcp-export")[0]?.value;
        if (!exporter) throw new Error("真实profile未装配桌面MCP出口");
        mcpClient = new Client({
          name: "native-task-mcp-consumer",
          version: "test",
        });
        if (transportForm === "HTTP") {
          httpOrigin = await installed.app.listen({
            host: "127.0.0.1",
            port: 0,
          });
          httpTransport = new StreamableHTTPClientTransport(
            new URL(
              `/api/computer-use/mcp?runId=${encodeURIComponent(runId)}`,
              httpOrigin,
            ),
            {
              requestInit: {
                headers: { authorization: `Bearer ${database.desktopToken}` },
              },
            },
          );
          await mcpClient.connect(adaptSdkTransport(httpTransport));
          expect(typeof httpTransport.sessionId).toBe("string");
        } else {
          mcpServer = exporter.createServer(task.actor, runId);
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          await mcpServer.connect(serverTransport);
          await mcpClient.connect(clientTransport);
        }
        const externalState = CallToolResultSchema.parse(
          await mcpClient.callTool({
            name: "get_app_state",
            arguments: { app: { pid: fixture.pid } },
          }),
        );
        expect(
          externalState.isError,
          JSON.stringify(
            externalState.structuredContent?.error ??
              externalState.content.filter((block) => block.type === "text"),
          ),
        ).not.toBe(true);
        const externalShot = await mcpClient.callTool({
          name: "screenshot",
          arguments: { app: { pid: fixture.pid } },
        });
        expect(
          CallToolResultSchema.parse(externalShot).content.some(
            (block) => block.type === "image",
          ),
        ).toBe(true);
        const preview = CallToolResultSchema.parse(externalShot).content.find(
          (block) => block.type === "image",
        );
        if (!preview || preview.type !== "image")
          throw new Error("超预算原图未返回预览");
        expect(preview.data.length).toBeLessThanOrEqual(
          AGENT_GOVERNANCE_DEFAULTS.computerUseScreenshotMaxBytes,
        );
        const decoded = PNG.sync.read(Buffer.from(preview.data, "base64"));
        expect(decoded.width).toBeLessThan(840);
        await expect
          .poll(
            () =>
              events.filter((event) => event.type === "tool.started").length,
            {
              timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
              interval: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
            },
          )
          .toBe(2);
        if (httpTransport && httpOrigin) {
          const endpoint = new URL(
            `/api/computer-use/mcp?runId=${encodeURIComponent(runId)}`,
            httpOrigin,
          );
          const sessionId = httpTransport.sessionId;
          if (!sessionId) throw new Error("原SDK未返回会话nonce");
          const headers = {
            authorization: `Bearer ${database.desktopToken}`,
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-11-25",
          };
          const anonymous = await fetch(endpoint, {
            method: "GET",
            headers: { accept: "text/event-stream" },
          });
          expect(anonymous.status).toBe(401);
          const other = await database.localAccess.createApiClient(
            {
              ip: "127.0.0.1",
              headers: { authorization: headers.authorization },
            },
            { label: "桌面MCP绑定验收" },
          );
          const borrowed = await fetch(endpoint, {
            method: "GET",
            headers: {
              ...headers,
              authorization: `Bearer ${other.token}`,
              accept: "text/event-stream",
            },
          });
          expect(borrowed.status).toBe(403);
          const changedRun = new URL(endpoint);
          changedRun.searchParams.set("runId", "different-real-run-required");
          expect(
            (
              await fetch(changedRun, {
                method: "GET",
                headers: { ...headers, accept: "text/event-stream" },
              })
            ).status,
          ).toBe(403);
          await installed.settings.updateInstanceSettings(
            task.actor,
            task.actor.instanceId,
            {
              computerUseInputDelayMs:
                AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs * 10,
            },
          );
          nativeOutput = "";
          const interrupted = new AbortController();
          const pendingKey = mcpClient
            .callTool(
              {
                name: "key",
                arguments: { app: { pid: fixture.pid }, keys: ["shift", "A"] },
              },
              undefined,
              { signal: interrupted.signal },
            )
            .then(
              (result) => ({ result }),
              (error) => ({ error }),
            );
          await expect
            .poll(() => nativeOutput.includes("SHIFT 1"), {
              timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
              interval: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
            })
            .toBe(true);
          testShiftHeld = true;
          const workers = (
            await exec("pgrep", [
              "-P",
              String(process.pid),
              "-f",
              "input-worker",
            ])
          ).stdout
            .trim()
            .split("\n")
            .map(Number);
          expect(workers).toHaveLength(1);
          frozenWorker = workers[0];
          if (!frozenWorker) throw new Error("实际输入worker未找到");
          process.kill(frozenWorker, "SIGSTOP");
          interrupted.abort();
          const cancelled = await pendingKey;
          expect(
            "error" in cancelled || cancelled.result.isError === true,
          ).toBe(true);
          // SDK的本地abort先返回；原工具还要join强制退出及一次独立释放，各自有动作预算。
          await expect
            .poll(
              () =>
                events.some(
                  (event) =>
                    event.type === "tool.completed" &&
                    event.toolName === `${CU_TOOL_PREFIX}key`,
                ),
              {
                timeout:
                  AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs * 2,
                interval: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
              },
            )
            .toBe(true);
          await expect
            .poll(
              async () => {
                const { stdout } = await exec("osascript", [
                  "-l",
                  "JavaScript",
                  "-e",
                  "ObjC.import('CoreGraphics'); Number($.CGEventSourceFlagsState(0) & (1 << 17));",
                ]);
                return Number(stdout.trim());
              },
              {
                timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
                interval: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
              },
            )
            .toBe(0);
          testShiftHeld = false;
          frozenWorker = undefined;
          await installed.settings.updateInstanceSettings(
            task.actor,
            task.actor.instanceId,
            {
              computerUseInputDelayMs:
                AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
            },
          );
          expect(
            JSON.stringify(events).includes(database.desktopToken) ||
              JSON.stringify(events).includes(other.token),
          ).toBe(false);
          otherHttpClient = new Client({
            name: "http-revoke-probe",
            version: "test",
          });
          const otherTransport = new StreamableHTTPClientTransport(endpoint, {
            requestInit: {
              headers: { authorization: `Bearer ${other.token}` },
            },
          });
          await otherHttpClient.connect(adaptSdkTransport(otherTransport));
          expect(
            (await otherHttpClient.listTools()).tools.some(
              (tool) => tool.name === "get_app_state",
            ),
          ).toBe(true);
          const otherSessionId = otherTransport.sessionId;
          if (!otherSessionId) throw new Error("被撤权SDK连接未取得nonce");
          await database.localAccess.revokeClient(
            {
              ip: "127.0.0.1",
              headers: { authorization: headers.authorization },
            },
            other.client.id,
          );
          expect(
            (
              await fetch(endpoint, {
                method: "GET",
                headers: {
                  ...headers,
                  "mcp-session-id": otherSessionId,
                  accept: "text/event-stream",
                },
              })
            ).status,
          ).toBe(404);
        }
        resumeModel();
        await pumping;
        await expect(
          mcpClient.callTool({
            name: "screenshot",
            arguments: { app: { pid: fixture.pid } },
          }),
        ).rejects.toThrow(/活动主Code Run|MCP会话不存在或已结束/);
        expect(
          events.at(-1)?.type,
          JSON.stringify(
            events.filter((event) =>
              ["run.failed", "run.canceled"].includes(event.type),
            ),
          ),
        ).toBe("run.completed");
        const snapshot = protocol.conversationSnapshotSchema.parse(
          task.host.getSnapshot(),
        );
        const shot = snapshot.rows.window.find(
          (row) =>
            row.kind === "toolCall" &&
            row.toolName === `${CU_TOOL_PREFIX}screenshot` &&
            row.status === "success",
        );
        expect(shot?.kind).toBe("toolCall");
        if (!shot || shot.kind !== "toolCall")
          throw new Error("V4缺少真实CUA图片行");
        const display = shot.output?.display;
        if (!display || display.kind !== "cua")
          throw new Error("V4未携带CUA展示投影");
        expect(
          display.media?.some(
            (block) =>
              block.mimeType === "image/png" &&
              typeof block.data === "string" &&
              block.data.length > 0,
          ),
        ).toBe(true);
        expect(
          snapshot.rows.window.some(
            (row) =>
              row.kind === "toolCall" &&
              row.toolName === `${CU_TOOL_PREFIX}screenshot` &&
              row.status === "error",
          ),
        ).toBe(true);
        expect(
          JSON.stringify(modelServer.requests).includes(
            "data:image/png;base64,",
          ),
        ).toBe(true);
        expect(
          JSON.stringify(modelServer.requests).includes("Task中文🙂🚀"),
        ).toBe(true);
        const finalMessages = modelServer.requests.at(-1)?.messages as Array<{
          tool_call_id?: string;
          content: unknown;
        }>;
        const observedText = finalMessages.find(
          (message) => message.tool_call_id === "desktop-model-6",
        )?.content;
        expect(JSON.stringify(observedText).includes("Task中文🙂🚀")).toBe(
          true,
        );
        expect(
          events.filter((event) => event.type === "tool.started").length,
        ).toBeGreaterThanOrEqual(6);
        await expect(
          installed.kernel
            .get("tools")
            .execute(
              `${CU_TOOL_PREFIX}screenshot`,
              { app: { pid: fixture.pid } },
              { runId, toolCallId: "untrusted-scope" },
            ),
        ).rejects.toBeInstanceOf(ToolDeniedError);
        await expect(
          installed.kernel
            .get("tools")
            .require(`${CU_TOOL_PREFIX}screenshot`)
            .execute(
              { app: { pid: fixture.pid } },
              { runId, toolCallId: "missing-trusted-task" },
            ),
        ).resolves.toMatchObject({
          isError: true,
          structuredContent: { error: { code: "context_required" } },
        });
      } finally {
        if (frozenWorker) {
          try {
            process.kill(frozenWorker, "SIGCONT");
          } catch {}
        }
        if (testShiftHeld)
          await exec("osascript", [
            "-l",
            "JavaScript",
            "-e",
            "ObjC.import('CoreGraphics'); const e=$.CGEventCreateKeyboardEvent(null,56,false); $.CGEventSetFlags(e,0); $.CGEventPost(0,e);",
          ]).catch(() => {});
        resumeModel();
        if (activeRunId) await task?.runtime.cancelRunAndWait(activeRunId);
        await pumping?.catch(() => {});
        await otherHttpClient?.close();
        await mcpClient?.close();
        await mcpServer?.close();
        await installed?.kernel.dispose();
        await installed?.app.close();
        await task?.work.close("macOS验收清理");
        await task?.persistence.dispose();
        await modelServer?.close();
        if (fixture && fixture.exitCode === null) {
          fixture.kill();
          await once(fixture, "exit");
        }
        await database.close();
      }
    },
    AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
  );
});
