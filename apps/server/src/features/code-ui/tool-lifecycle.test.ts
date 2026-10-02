import { HumanMessage } from "@langchain/core/messages";
import { createAgent, FakeToolCallingModel, tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { adaptDeepAgentStream } from "../../agent/stream-adapter.js";
import { createToolLifecycleMiddleware } from "./tool-lifecycle.js";

describe("Agent 公共工具生命周期", () => {
  it("真实 LangChain 工具运行以模型 call id 同源配对，并保留完整结果", async () => {
    const read = tool(async ({ path }) => `文件 ${path} 的正文`, {
      name: "read_file",
      description: "读取测试工作目录中的文件",
      schema: z.object({ path: z.string() }),
    });
    const agent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              id: "model-call-public-1",
              name: "read_file",
              args: { path: "/a.ts" },
            },
          ],
          [],
        ],
      }),
      tools: [read],
      middleware: [createToolLifecycleMiddleware()],
    });
    const events = [];
    for await (const event of adaptDeepAgentStream({
      conversationId: "conversation-public-1",
      sessionId: "session-public-1",
      runId: "run-public-1",
      canonicalToolEvents: true,
      stream: agent.streamEvents(
        { messages: [new HumanMessage("读取文件")] },
        { version: "v2" },
      ),
    }))
      events.push(event);

    expect(
      events
        .filter(
          (event) =>
            event.type === "tool.started" || event.type === "tool.completed",
        )
        .map((event) => ({
          type: event.type,
          toolCallId: event.toolCallId,
          ...(event.type === "tool.completed"
            ? { outputText: event.outputText }
            : {}),
        })),
    ).toEqual([
      { type: "tool.started", toolCallId: "model-call-public-1" },
      {
        type: "tool.completed",
        toolCallId: "model-call-public-1",
        outputText: "文件 /a.ts 的正文",
      },
    ]);
  });
});
