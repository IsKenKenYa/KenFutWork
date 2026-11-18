import type { StreamEvent } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createToolLifecycleMiddleware } from "../features/code-ui/tool-lifecycle.js";
import { archiveTaskFixture } from "../features/context-history/test-fixture.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";

class UnavailableToolModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  constructor(private readonly toolName: string) {
    super({});
  }
  _llmType() {
    return "unavailable-tool-contract";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    const message =
      this.requests.length === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              { id: "actual-unavailable-call", name: this.toolName, args: {} },
            ],
          })
        : new AIMessage("continued after actual tool failure");
    return { generations: [{ text: String(message.content), message }] };
  }
}

it.each(["GoneTool", "read_file"])(
  "native %s is an error tool result and cannot become successful Goal evidence",
  async (toolName) => {
    const task = await archiveTaskFixture();
    try {
      const model = new UnavailableToolModel(toolName);
      const read = vi.spyOn(task.handle.backend, "read");
      const agent = createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset: "code",
        model,
        systemPrompt: "use available tools",
        backendResult: { factory: () => task.handle.backend, ephemeral: false },
        runToolContext: task.execution,
        llmRetry: { maxAttempts: 1, infinite: false },
        runExtensions: [
          {
            preset: "code",
            canonicalToolEvents: true,
            createMiddleware: () => createToolLifecycleMiddleware(),
          },
        ],
      });
      const events: StreamEvent[] = [];
      for await (const event of adaptDeepAgentStream({
        runId: task.execution.runId ?? "actual-run",
        sessionId: task.identity.taskId,
        conversationId: task.identity.taskId,
        canonicalToolEvents: true,
        stream: agent.streamEvents(
          { messages: [{ role: "user", content: "attempt tool" }] },
          { version: "v2" },
        ),
      }))
        events.push(event);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool.completed",
          toolName,
          status: "error",
        }),
      );
      const toolResult = model.requests
        .flat()
        .find((message) => ToolMessage.isInstance(message));
      expect(toolResult).toMatchObject({ status: "error" });
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await task.cleanup();
    }
  },
);
