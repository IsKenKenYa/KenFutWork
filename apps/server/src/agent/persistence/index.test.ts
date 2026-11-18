import { HumanMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  type AgentPersistence,
  createAgentPersistenceService,
} from "./index.js";

function conversationGraph(persistence: AgentPersistence) {
  return new StateGraph(MessagesAnnotation)
    .addNode("remember", () => ({}))
    .addEdge(START, "remember")
    .addEdge("remember", END)
    .compile(persistence);
}

describe("Agent 内存持久化", () => {
  it("未配置数据库时，同一服务的下一轮可恢复 Task 消息", async () => {
    const service = createAgentPersistenceService({});
    const config = {
      configurable: { thread_id: "workspace-a:actor-a:task-a" },
    };
    const first = await service.getPersistence();
    if (!first) throw new Error("本地运行必须有内存持久化");
    await conversationGraph(first).invoke(
      { messages: [new HumanMessage("为 Task 保留下一轮需要的上下文")] },
      config,
    );

    const next = await service.getPersistence();
    if (!next) throw new Error("下一轮必须有内存持久化");
    const state = await conversationGraph(next).getState(config);
    expect(state.values).toMatchObject({
      messages: [{ content: "为 Task 保留下一轮需要的上下文" }],
    });
  });
});
