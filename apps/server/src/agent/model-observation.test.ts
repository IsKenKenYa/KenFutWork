import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { FilesystemBackend } from "deepagents";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";

it("最终模型观察收到实际发出的系统消息与工具，并保留原事件回调", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-model-observation-"));
  const provider = await heldModel({
    usage: { promptTokens: 31, completionTokens: 4 },
  });
  const starts: Array<{
    id: string;
    messages: BaseMessage[][];
    parameters: unknown;
  }> = [];
  const ends: string[] = [];
  const observer = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_model, messages, id, _parent, extra) {
      starts.push({ id, messages, parameters: extra?.invocation_params });
    },
    handleLLMEnd(_output, id) {
      ends.push(id);
    },
  });
  const external: string[] = [];
  const backend = new FilesystemBackend({
    rootDir: directory,
    virtualMode: true,
  });
  try {
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model: createInstanceChatModel("observed-model", {
        apiKey: "fixture-secret-must-not-be-recorded",
        baseUrl: provider.baseUrl,
        useResponsesApi: false,
        invocationMaxRetries: 0,
      }),
      backendResult: {
        factory: () => backend,
        sandboxDir: directory,
        ephemeral: false,
      },
      systemPrompt: "original system",
      llmRetry: { maxAttempts: 1, infinite: false },
      runExtensions: [
        {
          preset: "code",
          createModelCallbacks: () => [observer],
          createMiddleware: () => ({
            name: "LateRequestChange",
            wrapModelCall(request, handler) {
              return handler({
                ...request,
                systemMessage:
                  request.systemMessage.concat(" FINAL_SYSTEM_FACT"),
                tools: request.tools.filter(
                  (entry) => !("name" in entry) || entry.name !== "write_todos",
                ),
              });
            },
          }),
        },
      ],
    });
    const run = (async () => {
      for await (const event of agent.streamEvents(
        { messages: [{ role: "user", content: "actual user input" }] },
        {
          version: "v2",
          callbacks: [
            BaseCallbackHandler.fromMethods({
              handleChatModelStart(_llm, _messages, id) {
                external.push(id);
              },
            }),
          ],
        },
      )) {
        void event;
      }
    })();
    await provider.firstRequest;
    provider.finish(0);
    await run;
    expect(starts).toHaveLength(1);
    const first = starts[0];
    const wire = provider.requests[0]?.body;
    if (!first || !wire) throw new Error("模型调用没有实际输入记录。");
    expect(first.messages[0]?.map((message) => message.content)).toEqual(
      (wire.messages as Array<{ content: unknown }>).map(
        (message) => message.content,
      ),
    );
    expect(first.messages[0]?.[0]?.text).toContain("FINAL_SYSTEM_FACT");
    expect((first.parameters as { tools: unknown }).tools).toEqual(wire.tools);
    expect(JSON.stringify(first.parameters)).not.toContain(
      "fixture-secret-must-not-be-recorded",
    );
    expect(ends).toEqual([first.id]);
    expect(external).toEqual([first.id]);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
