import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { FilesystemBackend } from "deepagents";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";

it.each(["assistant", undefined])(
  "%s role空响应必须透出错误，不能被记为成功完成",
  async (role) => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-empty-model-"));
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* 仅替代外部模型HTTP */
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "empty-reply", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role, content: "" }, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("模型HTTP夹具未就绪");
      const backend = new FilesystemBackend({
        rootDir: directory,
        virtualMode: true,
      });
      const agent = createKenFutWorkDeepAgent({
        env: loadServerEnv({
          agentBackendMode: "filesystem",
          agentFilesRoot: directory,
        }),
        backendResult: {
          factory: () => backend,
          sandboxDir: directory,
          ephemeral: false,
        },
        model: createInstanceChatModel("test", {
          apiKey: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          useResponsesApi: false,
          invocationMaxRetries: 0,
        }),
        preset: "code",
        systemPrompt: "测试空响应边界",
        llmRetry: { maxAttempts: 1, infinite: false },
      });
      const events: StreamEvent[] = [];
      for await (const event of adaptDeepAgentStream({
        conversationId: "empty-task",
        sessionId: "empty-task",
        runId: "empty-run",
        stream: agent.streamEvents(
          { messages: [{ role: "user", content: "请观察" }] },
          { version: "v2" },
        ),
      }))
        events.push(event);
      expect(events.some((event) => event.type === "run.completed")).toBe(
        false,
      );
      const failed = events.find((event) => event.type === "run.failed");
      if (!failed || failed.type !== "run.failed")
        throw new Error("空响应未产生可见运行错误");
      expect(failed.error.message).toContain("模型返回空响应");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
