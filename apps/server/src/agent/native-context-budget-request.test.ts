import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { tool } from "langchain";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadServerEnv } from "../config/env.js";
import { createReadHistoryTool } from "../features/context-history/read-history-tool.js";
import { createContextHistoryArchiveBindings } from "../features/context-history/service.js";
import { archiveTaskFixture } from "../features/context-history/test-fixture.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";

class BudgetModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  readonly boundTools: string[] = [];
  _llmType() {
    return "actual-wire-budget-regression";
  }
  bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]) {
    for (const entry of tools)
      if ("name" in entry && typeof entry.name === "string")
        this.boundTools.push(entry.name);
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

it.each(["system", "tools"] as const)(
  "native budget counts actual late %s expansion before deciding compaction",
  async (kind) => {
    const fixture = await archiveTaskFixture();
    try {
      const model = new BudgetModel({});
      const archives = createContextHistoryArchiveBindings();
      const large = "actual late request context ".repeat(5_000);
      const evidenceTool = tool(async () => "unused", {
        name: "BudgetEvidence",
        description: large,
        schema: z.object({}),
      });
      const agent = createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset: "code",
        model,
        systemPrompt: "initial small prompt",
        checkpointer: new MemorySaver(),
        backendResult: {
          factory: () => fixture.handle.backend,
          ephemeral: false,
        },
        contextHistoryArchives: archives,
        kernelTools: [createReadHistoryTool(archives)],
        runToolContext: fixture.execution,
        autoCompact: {
          trigger: { type: "tokens", value: 10_000 },
          keep: { type: "messages", value: 1 },
          source: "fallback",
        },
        llmRetry: { maxAttempts: 1, infinite: false },
        runExtensions: [
          {
            preset: "code",
            createMiddleware: () => ({
              name: "ActualRequestExpansion",
              wrapModelCall(request, handler) {
                return handler({
                  ...request,
                  ...(kind === "system"
                    ? { systemMessage: request.systemMessage.concat(large) }
                    : { tools: [...request.tools, evidenceTool] }),
                });
              },
            }),
          },
        ],
      });
      for await (const _event of agent.streamEvents(
        {
          messages: [
            new HumanMessage("objective"),
            new AIMessage("pending"),
            new HumanMessage("continue"),
          ],
        },
        {
          configurable: { thread_id: fixture.execution.threadId },
          version: "v2",
        },
      )) {
      }
      if (kind === "system")
        expect(
          model.requests.some((request) =>
            request.some((message) => message.text.includes(large)),
          ),
        ).toBe(true);
      else expect(model.boundTools).toContain("BudgetEvidence");
      const summaries = model.requests.filter(
        (request) =>
          request.length === 1 &&
          typeof request[0]?.content === "string" &&
          request[0].content.startsWith("Create concise recovery notes"),
      );
      expect(summaries).toHaveLength(1);
      agent.releaseContextHistory?.();
    } finally {
      await fixture.cleanup();
    }
  },
);

it.each(["fixed-system", "fixed-tools", "retained-history"] as const)(
  "actual final delegated %s over known input cap never reaches the normal model",
  async (kind) => {
    const fixture = await archiveTaskFixture();
    try {
      const model = new BudgetModel({});
      const archives = createContextHistoryArchiveBindings();
      const agent = createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset: "code",
        model,
        systemPrompt:
          kind === "fixed-system"
            ? "fixed system ".repeat(5_000)
            : "small prompt",
        checkpointer: new MemorySaver(),
        backendResult: {
          factory: () => fixture.handle.backend,
          ephemeral: false,
        },
        contextHistoryArchives: archives,
        kernelTools: [createReadHistoryTool(archives)],
        runToolContext: fixture.execution,
        contextBudget: { inputTokenLimit: 4_096 },
        autoCompact: {
          trigger: { type: "tokens", value: 4_096 },
          keep: {
            type: "messages",
            value: kind === "retained-history" ? 20 : 1,
          },
          source: "fallback",
        },
        llmRetry: { maxAttempts: 1, infinite: false },
        runExtensions: [
          {
            preset: "code",
            createMiddleware: () => ({
              name: "FinalRequestBudgetEvidence",
              wrapModelCall(request, handler) {
                return handler(
                  kind === "fixed-tools"
                    ? {
                        ...request,
                        tools: [
                          ...request.tools,
                          tool(async () => "unused", {
                            name: "FixedBudgetEvidence",
                            description: "fixed tool context ".repeat(5_000),
                            schema: z.object({}),
                          }),
                        ],
                      }
                    : request,
                );
              },
            }),
          },
        ],
      });
      const consume = async () => {
        for await (const _event of agent.streamEvents(
          {
            messages: [
              new HumanMessage("objective"),
              new AIMessage("pending"),
              new HumanMessage(
                kind === "retained-history"
                  ? "retained input ".repeat(5_000)
                  : "continue",
              ),
            ],
          },
          {
            configurable: { thread_id: fixture.execution.threadId },
            version: "v2",
          },
        )) {
        }
      };
      await expect(consume()).rejects.toThrow("输入预算");
      const normal = model.requests.filter(
        (request) =>
          !(
            request.length === 1 &&
            request[0]?.text.startsWith("Create concise recovery notes")
          ),
      );
      expect(normal).toHaveLength(0);
      agent.releaseContextHistory?.();
    } finally {
      await fixture.cleanup();
    }
  },
);

it("disabling automatic compaction does not disable the actual model input cap", async () => {
  const fixture = await archiveTaskFixture();
  try {
    const model = new BudgetModel({});
    const archives = createContextHistoryArchiveBindings();
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model,
      systemPrompt: "fixed system ".repeat(5_000),
      checkpointer: new MemorySaver(),
      backendResult: {
        factory: () => fixture.handle.backend,
        ephemeral: false,
      },
      contextHistoryArchives: archives,
      kernelTools: [createReadHistoryTool(archives)],
      runToolContext: fixture.execution,
      contextBudget: { inputTokenLimit: 4_096 },
      llmRetry: { maxAttempts: 1, infinite: false },
    });
    const consume = async () => {
      for await (const _event of agent.streamEvents(
        { messages: [new HumanMessage("objective")] },
        {
          configurable: { thread_id: fixture.execution.threadId },
          version: "v2",
        },
      )) {
      }
    };
    await expect(consume()).rejects.toThrow("输入预算");
    expect(model.requests).toHaveLength(0);
    agent.releaseContextHistory?.();
  } finally {
    await fixture.cleanup();
  }
});

it("the same product budget object updates the next actual request even with auto compaction off", async () => {
  const fixture = await archiveTaskFixture();
  try {
    const model = new BudgetModel({});
    const archives = createContextHistoryArchiveBindings();
    const budget = { inputTokenLimit: 100_000 };
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model,
      systemPrompt: "fixed system ".repeat(5_000),
      checkpointer: new MemorySaver(),
      backendResult: {
        factory: () => fixture.handle.backend,
        ephemeral: false,
      },
      contextHistoryArchives: archives,
      kernelTools: [createReadHistoryTool(archives)],
      runToolContext: fixture.execution,
      contextBudget: budget,
      llmRetry: { maxAttempts: 1, infinite: false },
    });
    const consume = async (text: string) => {
      for await (const _event of agent.streamEvents(
        { messages: [new HumanMessage(text)] },
        {
          configurable: { thread_id: fixture.execution.threadId },
          version: "v2",
        },
      )) {
      }
    };
    await consume("first objective");
    expect(model.requests).toHaveLength(1);
    budget.inputTokenLimit = 4_096;
    await expect(consume("next objective")).rejects.toThrow("输入预算");
    expect(model.requests).toHaveLength(1);
    agent.releaseContextHistory?.();
  } finally {
    await fixture.cleanup();
  }
});
