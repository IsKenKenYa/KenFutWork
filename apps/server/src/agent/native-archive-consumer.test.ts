import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateBackend } from "deepagents";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import {
  archiveKernelFixture,
  archiveTaskFixture,
} from "../features/context-history/test-fixture.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";

class ReadingModel extends BaseChatModel {
  readonly pages: string[] = [];
  readonly summaryPrompts: string[] = [];
  private uri: string | undefined;
  private offset = 0;
  private complete = false;
  _llmType() {
    return "real-archive-consumer";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const first = messages[0];
    if (
      messages.length === 1 &&
      typeof first?.content === "string" &&
      first.content.startsWith("Create concise recovery notes")
    ) {
      this.summaryPrompts.push(first.content);
      return {
        generations: [
          { text: "remaining work", message: new AIMessage("remaining work") },
        ],
      };
    }
    const last = messages.at(-1);
    if (
      ToolMessage.isInstance(last) &&
      last.name === "ReadHistory" &&
      typeof last.content === "string"
    ) {
      const page = JSON.parse(last.content) as {
        text: string;
        nextOffset: number | null;
      };
      this.pages.push(page.text);
      this.complete = page.nextOffset === null;
      if (page.nextOffset !== null) this.offset = page.nextOffset;
    }
    if (!this.uri)
      for (const message of messages) {
        if (
          message.additional_kwargs.lc_source !== "summarization" ||
          typeof message.content !== "string"
        )
          continue;
        this.uri = /kfw-context-history:\/[A-Za-z0-9_-]+\.md/.exec(
          message.content,
        )?.[0];
      }
    const message =
      this.uri && !this.complete
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: `read-history-${this.offset}`,
                name: "ReadHistory",
                args: { uri: this.uri, offset: this.offset },
              },
            ],
          })
        : new AIMessage("done");
    return { generations: [{ text: "", message }] };
  }
}

it("production adapter compacts actual Task history and model reads exact original through registered ReadHistory", async () => {
  const fixture = await archiveTaskFixture();
  const kernel = archiveKernelFixture();
  try {
    const registry = kernel.get("tools");
    const definitions = registry
      .resolveRunTools({
        preset: "code",
        scopeHandle: fixture.handle,
        backendFactory: () => fixture.handle.backend,
      })
      .map((tool) => ({
        ...tool,
        execute: (
          args: Record<string, unknown>,
          execution: typeof fixture.execution,
        ) => registry.executeDefinition(tool, args, execution),
      }));
    const model = new ReadingModel({});
    const checkpointer = new MemorySaver();
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model,
      systemPrompt: "Continue task work with the registered tools.",
      checkpointer,
      backendResult: {
        factory: () => fixture.handle.backend,
        ephemeral: false,
      },
      runToolContext: fixture.execution,
      kernelTools: definitions,
      contextHistoryArchives: kernel.get("contextHistoryArchives"),
      autoCompact: {
        trigger: { type: "tokens", value: 4_000 },
        keep: { type: "messages", value: 1 },
        source: "fallback",
      },
      llmRetry: { maxAttempts: 1, infinite: false },
    });
    const original = "original 中文😀".repeat(3_000);
    for await (const _event of agent.streamEvents(
      {
        messages: [
          new HumanMessage(original),
          new AIMessage("unfinished work"),
          new HumanMessage("continue"),
        ],
      },
      {
        configurable: { thread_id: fixture.execution.threadId },
        version: "v2",
        recursionLimit: 30,
      },
    )) {
    }
    expect(model.summaryPrompts.length).toBeGreaterThan(0);
    expect(model.pages.length).toBeGreaterThan(1);
    expect(model.pages.join("")).toContain(original);
    expect(model.pages.join("")).toContain("unfinished work");
    agent.releaseContextHistory?.();
    await expect(
      kernel
        .get("contextHistoryArchives")
        .read({ uri: "any" }, fixture.execution),
    ).rejects.toThrow("没有可读取");
  } finally {
    kernel.dispose();
    await fixture.cleanup();
  }
});

it("production archive capability fails loud without its Consumer and never borrows a canvas scope", async () => {
  const fixture = await archiveTaskFixture();
  try {
    expect(() =>
      createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset: "code",
        model: new ReadingModel({}),
        systemPrompt: "test",
        checkpointer: new MemorySaver(),
        runToolContext: fixture.execution,
        backendResult: {
          factory: () => fixture.handle.backend,
          ephemeral: false,
        },
      }),
    ).toThrow("未完整装配");
  } finally {
    await fixture.cleanup();
  }
});

it.each(["code", "design"] as const)(
  "%s production manual maintenance uses the same owned Provider and registered readonly Consumer",
  async (preset) => {
    const fixture = await archiveTaskFixture(preset);
    const kernel = archiveKernelFixture();
    try {
      const registry = kernel.get("tools");
      const definitions = registry.resolveRunTools({
        preset,
        scopeHandle: fixture.handle,
        backendFactory: () => fixture.handle.backend,
      });
      const agent = createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset,
        model: new ReadingModel({}),
        systemPrompt: "continue",
        checkpointer: new MemorySaver(),
        backendResult: {
          factory: () => fixture.handle.backend,
          ephemeral: false,
        },
        runToolContext: fixture.execution,
        kernelTools: definitions,
        contextHistoryArchives: kernel.get("contextHistoryArchives"),
        manualCompactPlan: {
          trigger: { type: "tokens", value: 4_000 },
          keep: { type: "messages", value: 1 },
          source: "fallback",
        },
        llmRetry: { maxAttempts: 1, infinite: false },
      });
      for await (const _event of agent.streamEvents(
        {
          messages: [
            new HumanMessage("original objective"),
            new AIMessage("unfinished evidence"),
            new HumanMessage("continue"),
          ],
        },
        {
          configurable: { thread_id: fixture.execution.threadId },
          version: "v2",
        },
      )) {
      }
      const history = agent.contextHistory;
      const threadId = fixture.execution.threadId;
      if (!history || !threadId)
        throw new Error("real native maintenance port missing");
      const compacted = await history.compactCurrent({ threadId });
      if (compacted.status !== "applied")
        throw new Error("manual compaction did not apply");
      const state = await history.getEffectiveState(compacted.reference);
      const summary = state.messages.find((message) => message.summary);
      if (typeof summary?.content !== "string")
        throw new Error("committed summary missing");
      const uri = /kfw-context-history:\/[A-Za-z0-9_-]+\.md/.exec(
        summary.content,
      )?.[0];
      const read = definitions.find((tool) => tool.name === "ReadHistory");
      if (!uri || !read) throw new Error("archive Consumer binding missing");
      const result = await registry.executeDefinition(
        read,
        { uri },
        fixture.execution,
      );
      expect(result).toMatchObject({
        uri,
        text: expect.stringContaining("unfinished evidence"),
      });
      fixture.staleBranch();
      await expect(
        registry.executeDefinition(read, { uri }, fixture.execution),
      ).rejects.toThrow("分支");
      agent.releaseContextHistory?.();
    } finally {
      kernel.dispose();
      await fixture.cleanup();
    }
  },
);

class ShortDesignModel extends ReadingModel {
  override async _generate() {
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

it("legacy Design with a checkpointer and no Task still performs its short first model call", async () => {
  const agent = createKenFutWorkDeepAgent({
    env: loadServerEnv({}, {}),
    preset: "design",
    model: new ShortDesignModel({}),
    backendResult: { factory: () => new StateBackend(), ephemeral: false },
    systemPrompt: "short Design request",
    checkpointer: new MemorySaver(),
  });
  try {
    const events = [];
    for await (const event of agent.streamEvents(
      { messages: [new HumanMessage("hello")] },
      {
        configurable: { thread_id: "legacy-design-first-call" },
        version: "v2",
      },
    ))
      events.push(event.event);
    expect(events).toContain("on_chat_model_end");
  } finally {
    agent.releaseContextHistory?.();
  }
});

it("Code with persistent history refuses a missing real Task scope before opening its model", () => {
  expect(() =>
    createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model: new ReadingModel({}),
      systemPrompt: "Code without Task",
      checkpointer: new MemorySaver(),
    }),
  ).toThrow("Task");
});
