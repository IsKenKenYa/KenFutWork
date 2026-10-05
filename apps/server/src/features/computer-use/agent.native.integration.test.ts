import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { ChatOpenAI } from "@langchain/openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { ToolDeniedError } from "../../kernel/context.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createDesktopModelServer } from "./fixtures/model-server.js";
import { installedKernel, taskRuntime } from "./fixtures/task-agent.js";
import type { ComputerUseMcpExport } from "./mcp-server.js";
import { CU_TOOL_PREFIX } from "./tools.js";

const exec = promisify(execFile);
const enabled =
  process.platform === "darwin" && process.env.KENFUTWORK_TEST_DESKTOP === "1";

describe.skipIf(!enabled)("真实macOS Task→插件→Agent→模型HTTP→V4事件", () => {
  it(
    "持久Task实际调用CUA，模型HTTP拿到PNG且原V4行保留结果",
    async () => {
      const database = await createTaskWorkDatabase();
      let fixture: ReturnType<typeof spawn> | undefined;
      let installed: Awaited<ReturnType<typeof installedKernel>> | undefined;
      let task: Awaited<ReturnType<typeof taskRuntime>> | undefined;
      let modelServer:
        | Awaited<ReturnType<typeof createDesktopModelServer>>
        | undefined;
      let mcpClient: Client | undefined;
      let mcpServer: Server | undefined;
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
        fixture = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
        await once(fixture.stdout!, "data");
        modelServer = await createDesktopModelServer(fixture.pid!, {
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
          new ChatOpenAI({
            apiKey: "desktop-fixture",
            model: "desktop-fixture",
            useResponsesApi: false,
            configuration: { baseURL: modelServer.baseURL },
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
        mcpServer = exporter.createServer(task.actor, runId);
        mcpClient = new Client({
          name: "native-task-mcp-consumer",
          version: "test",
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        await mcpClient.connect(clientTransport);
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
        resumeModel();
        await pumping;
        await expect(
          mcpClient.callTool({
            name: "screenshot",
            arguments: { app: { pid: fixture.pid } },
          }),
        ).rejects.toThrow("活动主Code Run");
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
            row.toolName === `${CU_TOOL_PREFIX}screenshot`,
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
          (message) => message.tool_call_id === "desktop-model-5",
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
        resumeModel();
        if (activeRunId) await task?.runtime.cancelRunAndWait(activeRunId);
        await pumping?.catch(() => {});
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
