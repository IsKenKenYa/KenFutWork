import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { FilesystemBackend } from "deepagents";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import type { CompactionPlan } from "./auto-compact.js";
import type { AgentBackendResult } from "./backends/index.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { createAgentPersistenceService } from "./persistence/index.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";

/** LLM 系统边界：记录真实框架调用，native graph/middleware/persistence不替换。 */
class ControlledModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  constructor(private readonly onRequest?: (messages: BaseMessage[]) => void) {
    super({});
  }
  _llmType(): string {
    return "controlled-compaction-model";
  }
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    this.onRequest?.(messages);
    return {
      generations: [{ text: "已完成", message: new AIMessage("已完成") }],
    };
  }
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Harness 真实上下文压缩生命周期", () => {
  it("两次真实 native run 共用历史时，旧摘要复用不能被报告为本轮新压缩", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "kfw-compaction-lifecycle-"),
    );
    try {
      const env = loadServerEnv({
        agentBackendMode: "filesystem",
        agentFilesRoot: directory,
      });
      const persistenceService = createAgentPersistenceService({});
      const model = new ControlledModel();
      const backend = new FilesystemBackend({
        rootDir: directory,
        virtualMode: true,
      });
      const backendResult: AgentBackendResult = {
        factory: () => backend,
        sandboxDir: directory,
        ephemeral: false,
      };
      // 前10条超阈值、后20条很短：首次真实压缩后的有效输入明显低于同一触发线。
      const plan: CompactionPlan = {
        trigger: { type: "tokens", value: 10_000 },
        keep: { type: "messages", value: 20 },
        source: "reserved-output",
      };
      const history = Array.from({ length: 30 }, (_, index): BaseMessage => {
        const text =
          index < 10 ? `${index}:${"x".repeat(10_000)}` : `短消息 ${index}`;
        return index % 2 ? new AIMessage(text) : new HumanMessage(text);
      });
      const firstPersistence = await persistenceService.getPersistence();
      if (!firstPersistence) throw new Error("实际循环必须有MemorySaver");
      const firstAgent = createKenFutWorkDeepAgent({
        env,
        backendResult,
        model,
        preset: "code",
        systemPrompt: "测试上下文生命周期",
        autoCompact: plan,
        ...firstPersistence,
      });
      const config = {
        version: "v2" as const,
        configurable: { thread_id: "owned-task-compaction" },
      };
      const first = await collect(
        adaptDeepAgentStream({
          conversationId: "owned-task-compaction",
          sessionId: "owned-task-compaction",
          runId: "first-run",
          autoCompact: plan,
          stream: firstAgent.streamEvents({ messages: history }, config),
        }),
      );
      expect(
        first.filter((event) => event.type === "run.compacted"),
      ).toHaveLength(1);
      expect(first.at(-1)?.type).toBe("run.completed");
      const firstReference =
        await firstAgent.contextHistory?.captureCurrentReference(
          "owned-task-compaction",
        );
      if (!firstReference || !firstAgent.contextHistory)
        throw new Error("真实压缩必须有已提交历史引用");
      const effective =
        await firstAgent.contextHistory.getEffectiveState(firstReference);
      expect(
        effective.messages.filter((message) => message.summary),
      ).toHaveLength(1);
      expect(
        effective.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("x".repeat(10_000)),
        ),
      ).toBe(false);
      const beforeSecond = model.requests.length;
      const nextPersistence = await persistenceService.getPersistence();
      if (!nextPersistence) throw new Error("下一轮必须复用实际持久化");
      const nextAgent = createKenFutWorkDeepAgent({
        env,
        backendResult,
        model,
        preset: "code",
        systemPrompt: "测试上下文生命周期",
        autoCompact: plan,
        ...nextPersistence,
      });
      const second = await collect(
        adaptDeepAgentStream({
          conversationId: "owned-task-compaction",
          sessionId: "owned-task-compaction",
          runId: "second-run",
          autoCompact: plan,
          stream: nextAgent.streamEvents(
            { messages: [new HumanMessage("沿用上下文继续")] },
            config,
          ),
        }),
      );
      const actualSecondRequests = model.requests.slice(beforeSecond);
      expect(actualSecondRequests).toHaveLength(1);
      expect(
        actualSecondRequests[0]?.some(
          (message) => message.additional_kwargs.lc_source === "summarization",
        ),
      ).toBe(true);
      expect(second.filter((event) => event.type === "run.compacted")).toEqual(
        [],
      );
      expect(second.at(-1)?.type).toBe("run.completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("native历史port保存精确checkpoint引用，后续运行不改写旧引用也不保存调用凭据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-context-reference-"));
  try {
    const env = loadServerEnv({
      agentBackendMode: "filesystem",
      agentFilesRoot: directory,
    });
    const saved = await createAgentPersistenceService({}).getPersistence();
    if (!saved) throw new Error("实际历史port需要MemorySaver");
    const backend = new FilesystemBackend({
      rootDir: directory,
      virtualMode: true,
    });
    const agent = createKenFutWorkDeepAgent({
      env,
      model: new ControlledModel(),
      preset: "code",
      systemPrompt: "历史引用验证",
      backendResult: {
        factory: () => backend,
        sandboxDir: directory,
        ephemeral: false,
      },
      ...saved,
    });
    const port = agent.contextHistory;
    if (!port) throw new Error("实际native adapter必须提供contextHistory");
    expect(await port.captureCurrentReference("history-port")).toBeNull();
    const config = {
      version: "v2" as const,
      configurable: {
        thread_id: "history-port",
        access_token: "must-not-persist-token",
        user_attachment_map: { secret: "must-not-persist-bytes" },
      },
    };
    for await (const _event of agent.streamEvents(
      { messages: [new HumanMessage({ id: "first", content: "第一轮" })] },
      config,
    )) {
    }
    const first = await port.captureCurrentReference("history-port");
    if (!first) throw new Error("首轮没有实际checkpoint引用");
    expect(JSON.stringify(first)).not.toContain("must-not-persist");
    for await (const _event of agent.streamEvents(
      { messages: [new HumanMessage({ id: "second", content: "第二轮" })] },
      config,
    )) {
    }
    const second = await port.captureCurrentReference("history-port");
    expect(second).not.toEqual(first);
    const oldState = await port.getEffectiveState(first);
    expect(oldState.messages).toContainEqual(
      expect.objectContaining({ id: "first", content: "第一轮" }),
    );
    expect(oldState.messages.some((message) => message.id === "second")).toBe(
      false,
    );
    if (!second) throw new Error("次轮没有实际checkpoint引用");
    expect((await port.getEffectiveState(second)).messages).toContainEqual(
      expect.objectContaining({ id: "second", content: "第二轮" }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** 系统storage故障边界：所有state仍由真实Saver保存，只拒绝后续持久checkpoint提交。 */
class RefusingCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly delegate: BaseCheckpointSaver,
    private readonly refuse: () => boolean,
  ) {
    super(delegate.serde);
  }
  getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>) {
    return this.delegate.getTuple(...args);
  }
  async *list(...args: Parameters<BaseCheckpointSaver["list"]>) {
    yield* this.delegate.list(...args);
  }
  put(...args: Parameters<BaseCheckpointSaver["put"]>) {
    if (this.refuse())
      return Promise.reject(
        new Error("system checkpoint storage refused commit"),
      );
    return this.delegate.put(...args);
  }
  putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>) {
    return this.delegate.putWrites(...args);
  }
  deleteThread(...args: Parameters<BaseCheckpointSaver["deleteThread"]>) {
    return this.delegate.deleteThread(...args);
  }
}

it("真实summary模型调用后checkpoint提交失败，pending write不能被报告成已提交压缩", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "kfw-compaction-storage-failure-"),
  );
  try {
    const env = loadServerEnv({
      agentBackendMode: "filesystem",
      agentFilesRoot: directory,
    });
    const saved = await createAgentPersistenceService({}).getPersistence();
    if (!saved) throw new Error("实际故障边界需要MemorySaver");
    let refuse = false;
    const model = new ControlledModel((messages) => {
      if (
        messages.some(
          (message) => message.additional_kwargs.lc_source === "summarization",
        )
      )
        refuse = true;
    });
    const backend = new FilesystemBackend({
      rootDir: directory,
      virtualMode: true,
    });
    const plan: CompactionPlan = {
      trigger: { type: "tokens", value: 10_000 },
      keep: { type: "messages", value: 20 },
      source: "reserved-output",
    };
    const agent = createKenFutWorkDeepAgent({
      env,
      model,
      preset: "code",
      systemPrompt: "持久提交故障边界",
      backendResult: {
        factory: () => backend,
        sandboxDir: directory,
        ephemeral: false,
      },
      autoCompact: plan,
      checkpointer: new RefusingCheckpointSaver(
        saved.checkpointer,
        () => refuse,
      ),
      store: saved.store,
    });
    const history = Array.from({ length: 30 }, (_, index): BaseMessage => {
      const content =
        index < 10 ? `${index}:${"x".repeat(10_000)}` : `短消息 ${index}`;
      return index % 2 ? new AIMessage(content) : new HumanMessage(content);
    });
    const events = await collect(
      adaptDeepAgentStream({
        conversationId: "storage-failure",
        sessionId: "storage-failure",
        runId: "storage-failure-run",
        autoCompact: plan,
        stream: agent.streamEvents(
          { messages: history },
          { version: "v2", configurable: { thread_id: "storage-failure" } },
        ),
      }),
    );
    expect(
      model.requests.some((messages) =>
        messages.some(
          (message) => message.additional_kwargs.lc_source === "summarization",
        ),
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(events.filter((event) => event.type === "run.compacted")).toEqual(
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
