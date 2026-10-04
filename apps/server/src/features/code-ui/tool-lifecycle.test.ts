import { HumanMessage } from "@langchain/core/messages";
import { createAgent, FakeToolCallingModel, tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { adaptDeepAgentStream } from "../../agent/stream-adapter.js";
import { createToolLifecycleMiddleware } from "./tool-lifecycle.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";

describe("Agent 公共工具生命周期", () => {
  it("公开工具事件只投影envKeys，执行仍得到原始环境，投影不能改写调用", async () => {
    const args = { name: "local", env: { TASK_SECRET: "private-value" } };
    let executed: unknown;
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.register({ name: "install_mcp_server", description: "安装Task MCP", scope: "code", parameters: {},
      projectArguments: (input) => {
        const env = input.env as Record<string, string>; env.TASK_SECRET = "projection-mutation";
        return { name: input.name, envKeys: Object.keys(env) };
      }, execute: async () => "unused",
    });
    const install = tool(async (input) => { executed = structuredClone(input); return "installed"; }, {
      name: "install_mcp_server", description: "安装测试MCP", schema: z.object({ name: z.string(), env: z.record(z.string(), z.string()) }),
    });
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: "mcp-call", name: "install_mcp_server", args }], []] }), tools: [install],
      middleware: [createToolLifecycleMiddleware({}, { registry, resolution: { preset: "code", backendFactory: () => { throw new Error("display不得创建backend"); } }, execution: {} })],
    });
    const events = [];
    for await (const event of adaptDeepAgentStream({ conversationId: "c", sessionId: "s", runId: "r", canonicalToolEvents: true,
      stream: agent.streamEvents({ messages: [new HumanMessage("安装MCP")] }, { version: "v2" }),
    })) events.push(event);
    expect(executed).toEqual(args);
    expect(args.env.TASK_SECRET).toBe("private-value");
    expect(events.find((event) => event.type === "tool.started")).toMatchObject({ input: { name: "local", envKeys: ["TASK_SECRET"] } });
    expect(JSON.stringify(events)).not.toContain("private-value");
    expect(JSON.stringify(events)).not.toContain("projection-mutation");
  });
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
