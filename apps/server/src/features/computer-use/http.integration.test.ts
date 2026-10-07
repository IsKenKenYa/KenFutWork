import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { adaptSdkTransport } from "../mcp/sdk-transport.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createDesktopModelServer } from "./fixtures/model-server.js";
import { installedKernel, taskRuntime } from "./fixtures/task-agent.js";
import type { ComputerUseMcpSource } from "./mcp-backend.js";

function startDesktopCall(
  endpoint: URL,
  headers: Record<string, string>,
  id: string,
) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "click",
        arguments: {
          app: { name: "peer" },
          target: { type: "element", index: 50 },
        },
      },
    }),
  });
}

async function expectCancelledPost(pending: Promise<Response>) {
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.text();
  // Protocol可抑制响应，也可在close之前完成原取消结果；actionSent不是成功标志。
  const data = body.split("\n").filter((line) => line.startsWith("data: "));
  for (const line of data)
    expect(JSON.parse(line.slice(6))).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: "cancelled" } },
      },
    });
  if (!data.length) expect(body.replace(/^:.*$/gm, "").trim()).toBe("");
}

// 真实PG/Task/Agent/HTTP/SDK/stdio peer；只验证协议和信号，不宣称OS操作。
it.skipIf(process.env.KENFUTWORK_MCP_HTTP_TEST !== "1")(
  "同一HTTP session的跨POST取消到真实stdio，撤权与Run停止关闭会话",
  async () => {
    const database = await createTaskWorkDatabase();
    const peer = new Client({ name: "http-desktop-peer", version: "test" });
    const peerTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/mcp-peer.ts", import.meta.url)),
        "repeat-cancel",
      ],
      env: {},
      stderr: "pipe",
    });
    let installed: Awaited<ReturnType<typeof installedKernel>> | undefined;
    let task: Awaited<ReturnType<typeof taskRuntime>> | undefined;
    let model: Awaited<ReturnType<typeof createDesktopModelServer>> | undefined;
    let client: Client | undefined;
    let secondClient: Client | undefined;
    let runId: string | undefined;
    let pumping: Promise<void> | undefined;
    let resumeModel = () => {};
    let modelStarted = () => {};
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resumeModel = resolve;
    });
    const notices: unknown[] = [];
    peer.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (notification) => {
        notices.push(notification.params.data);
      },
    );
    try {
      await peer.connect(peerTransport);
      const provider: PluginDefinition = {
        name: "http-test:actual-stdio-provider",
        inject: [],
        apply(ctx) {
          ctx.effect(() =>
            ctx
              .get("capabilities")
              .register<ComputerUseMcpSource>("computer-use-mcp-source", {
                id: "http-test:live-peer",
                value: {
                  list: async () => [
                    {
                      id: "http-test-peer",
                      name: "actual stdio protocol fixture",
                      call: (name, args, context) =>
                        peer.callTool(
                          { name, arguments: args },
                          undefined,
                          context.signal ? { signal: context.signal } : {},
                        ),
                    },
                  ],
                },
              }),
          );
        },
      };
      model = await createDesktopModelServer(1, {
        beforeResponse: async (stage) => {
          if (stage === 0) {
            modelStarted();
            await gate;
          }
        },
      });
      const env = loadServerEnv({
        agentBackendMode: "filesystem",
        agentFilesRoot: database.directory,
        checkpointRoot: database.directory,
      });
      installed = await installedKernel(database, env, [provider]);
      task = await taskRuntime(
        database,
        installed,
        env,
        new ChatOpenAI({
          apiKey: "http-protocol-fixture",
          model: "http-protocol-fixture",
          useResponsesApi: false,
          configuration: { baseURL: model.baseURL },
        }),
      );
      const currentTask = task;
      const created = task.runtime.createRun(
        {
          sessionId: task.scope.taskId,
          conversationId: task.scope.taskId,
          projectId: task.scope.projectId,
          taskId: task.scope.taskId,
          preset: "code",
          prompt: "只读协议验收",
        },
        {
          threadId: task.threadId,
          scopeHandle: task.handle,
          actor: task.actor,
          eventSink: async (event) => {
            currentTask.host.recordEvent(event);
          },
        },
      );
      runId = created.runId;
      await task.metadata().createAcceptedRun({
        runId,
        sessionId: task.scope.taskId,
        threadId: task.threadId,
      });
      task.host.startTurn({
        runId,
        commandId: "http-protocol-test",
        text: "真实HTTP协议测试",
      });
      pumping = (async () => {
        for await (const _event of currentTask.runtime.streamRun(
          created.runId,
        )) {
          /* 原eventSink消费 */
        }
      })();
      await Promise.race([
        started,
        pumping.then(() => {
          throw new Error("Run未进入真实模型HTTP");
        }),
      ]);
      const origin = await installed.app.listen({ host: "127.0.0.1", port: 0 });
      const endpoint = new URL(
        `/api/computer-use/mcp?runId=${encodeURIComponent(runId)}`,
        origin,
      );
      const headers = { authorization: `Bearer ${database.desktopToken}` };
      const http = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers },
      });
      client = new Client({
        name: "actual-http-desktop-consumer",
        version: "test",
      });
      await client.connect(adaptSdkTransport(http));
      expect(
        CallToolResultSchema.parse(
          await client.callTool({
            name: "select_backend",
            arguments: { id: "mcp:http-test-peer" },
          }),
        ).isError,
      ).not.toBe(true);
      expect(
        CallToolResultSchema.parse(
          await client.callTool({
            name: "get_app_state",
            arguments: { app: { name: "peer" } },
          }),
        ).isError,
      ).not.toBe(true);
      const interrupted = new AbortController();
      const pending = client
        .callTool(
          {
            name: "click",
            arguments: {
              app: { name: "peer" },
              target: { type: "element", index: 50 },
            },
          },
          undefined,
          { signal: interrupted.signal },
        )
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
      await expect.poll(() => notices.includes("request-started")).toBe(true);
      interrupted.abort();
      expect("error" in (await pending)).toBe(true);
      await expect.poll(() => notices.includes("request-cancelled")).toBe(true);
      const sessionId = http.sessionId;
      if (!sessionId) throw new Error("SDK未取得真实HTTP session");
      const authorizer = { ip: "127.0.0.1", headers };
      const other = await database.localAccess.createApiClient(authorizer, {
        label: "HTTP绑定/撤权协议验收",
      });
      const bound = {
        ...headers,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
        accept: "text/event-stream",
      };
      expect(
        (
          await fetch(endpoint, {
            method: "GET",
            headers: { accept: "text/event-stream" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(endpoint, {
            method: "GET",
            headers: { ...bound, authorization: `Bearer ${other.token}` },
          })
        ).status,
      ).toBe(403);
      const otherTransport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${other.token}` } },
      });
      secondClient = new Client({
        name: "http-revoked-consumer",
        version: "test",
      });
      await secondClient.connect(adaptSdkTransport(otherTransport));
      const otherId = otherTransport.sessionId;
      if (!otherId) throw new Error("第二个真实SDK session未初始化");
      // 同requestId的另一session取消不能影响原请求；正确取消还须结束原POST body。
      const rawCall = startDesktopCall(endpoint, bound, "http-body-cancel");
      await expect
        .poll(() => notices.filter((item) => item === "request-started").length)
        .toBe(2);
      const cancelHeaders = {
        ...bound,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      const cancelBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "http-body-cancel" },
      });
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: {
              ...cancelHeaders,
              authorization: `Bearer ${other.token}`,
              "mcp-session-id": otherId,
            },
            body: cancelBody,
          })
        ).status,
      ).toBe(202);
      expect(
        notices.filter((item) => item === "request-cancelled"),
      ).toHaveLength(1);
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: cancelHeaders,
            body: cancelBody,
          })
        ).status,
      ).toBe(202);
      await expect
        .poll(
          () => notices.filter((item) => item === "request-cancelled").length,
        )
        .toBe(2);
      const cancelledResponse = await rawCall;
      expect(cancelledResponse.status).toBe(200);
      expect(await cancelledResponse.text()).toBe("");
      // DELETE只结束所属SDK session；Run和另一session继续可用，重复DELETE拒绝旧nonce。
      expect(
        (await fetch(endpoint, { method: "DELETE", headers: bound })).status,
      ).toBe(200);
      expect(
        (await fetch(endpoint, { method: "DELETE", headers: bound })).status,
      ).toBe(404);
      expect(
        (await secondClient.listTools()).tools.some(
          (tool) => tool.name === "click",
        ),
      ).toBe(true);
      await client.close();
      const replacement = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers },
      });
      client = new Client({ name: "http-after-delete", version: "test" });
      await client.connect(adaptSdkTransport(replacement));
      const replacementId = replacement.sessionId;
      if (!replacementId) throw new Error("DELETE后SDK会话未重建");
      const revokedCall = startDesktopCall(
        endpoint,
        {
          ...bound,
          authorization: `Bearer ${other.token}`,
          "mcp-session-id": otherId,
        },
        "http-revoke-pending",
      );
      await expect
        .poll(() => notices.filter((item) => item === "request-started").length)
        .toBe(3);
      await database.localAccess.revokeClient(authorizer, other.client.id);
      await expect
        .poll(
          () => notices.filter((item) => item === "request-cancelled").length,
        )
        .toBe(3);
      await expectCancelledPost(revokedCall);
      expect(
        (
          await fetch(endpoint, {
            method: "GET",
            headers: { ...bound, "mcp-session-id": otherId },
          })
        ).status,
      ).toBe(404);
      const stoppedCall = startDesktopCall(
        endpoint,
        { ...bound, "mcp-session-id": replacementId },
        "http-run-stop-pending",
      );
      await expect
        .poll(() => notices.filter((item) => item === "request-started").length)
        .toBe(4);
      await task.runtime.cancelRunAndWait(runId);
      await expect
        .poll(
          () => notices.filter((item) => item === "request-cancelled").length,
        )
        .toBe(4);
      await expectCancelledPost(stoppedCall);
      resumeModel();
      await pumping;
      const expired = await fetch(endpoint, {
        method: "GET",
        headers: {
          ...headers,
          "mcp-session-id": replacementId,
          "mcp-protocol-version": "2025-11-25",
          accept: "text/event-stream",
        },
      });
      expect(expired.status, JSON.stringify(await expired.json())).toBe(404);
    } finally {
      resumeModel();
      if (runId) await task?.runtime.cancelRunAndWait(runId);
      await pumping?.catch(() => {});
      await secondClient?.close();
      await client?.close();
      await peer.close();
      await peerTransport.close();
      await installed?.kernel.dispose();
      await installed?.app.close();
      await task?.work.close("HTTP协议测试清理");
      await task?.persistence.dispose();
      await model?.close();
      await database.close();
    }
  },
  120_000,
);
