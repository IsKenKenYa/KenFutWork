import { randomUUID } from "node:crypto";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { archiveTaskFixture } from "../features/context-history/test-fixture.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { createDeepAgentsProvider } from "./deepagents-provider.js";
import { consumeAgentProviderStream } from "./provider-contract.js";

class ControlledModel extends BaseChatModel {
  _llmType() {
    return "provider-contract-evidence";
  }
  bindTools() {
    return this;
  }
  async _generate() {
    return {
      generations: [
        {
          text: "actual native response",
          message: new AIMessage("actual native response"),
        },
      ],
    };
  }
}

it("the default Provider reuses the actual native factory and emits product lifecycle events", async () => {
  const task = await archiveTaskFixture();
  try {
    let factoryCalls = 0;
    const provider = createDeepAgentsProvider({
      createAgent() {
        factoryCalls++;
        return createKenFutWorkDeepAgent({
          env: loadServerEnv({}, {}),
          preset: "code",
          model: new ControlledModel({}),
          systemPrompt: "Answer concisely",
          backendResult: {
            factory: () => task.handle.backend,
            ephemeral: true,
          },
          runToolContext: task.execution,
          llmRetry: { maxAttempts: 1, infinite: false },
        });
      },
      config: () => ({
        configurable: { thread_id: task.execution.threadId },
        version: "v2",
      }),
    });
    const context = {
      systemPrompt: "Answer concisely",
      runId: task.execution.runId ?? randomUUID(),
      sessionId: randomUUID(),
      conversationId: randomUUID(),
      tools: {
        catalog: [],
        execute: async () => {
          throw new Error("No tools registered");
        },
      },
    };
    const session = await provider.open(context);
    const events = [];
    for await (const event of consumeAgentProviderStream(
      session,
      { messages: [{ content: "hello" }] },
      context,
    ))
      events.push(event);
    expect(factoryCalls).toBe(1);
    expect(events[0]).toMatchObject({
      type: "run.started",
      runId: context.runId,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        delta: "actual native response",
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      runId: context.runId,
    });
    session.release?.();
  } finally {
    await task.cleanup();
  }
});
