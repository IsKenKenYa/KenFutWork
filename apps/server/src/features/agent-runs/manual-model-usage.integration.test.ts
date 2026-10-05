import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type StandardMessageStructure,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import type { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createRunUsageAccumulator } from "../usage/run-usage-accumulator.js";
import { BoundaryModel, createHarness } from "./test-harness.js";

const SUMMARY_TEXT = "MANUAL_USAGE_NATIVE_SUMMARY_9e035f2a：保留真实历史事实。";
type Harness = Awaited<ReturnType<typeof createHarness>>;

/** 只控制模型生成边界；请求、SDK callback 身份、summary 与 checkpoint 均走真实实现。 */
class ManualUsageModel extends BoundaryModel {
  readonly sdkStarts: string[] = [];
  readonly sdkEnds: string[] = [];

  constructor() {
    super();
    this.callbacks = [
      {
        name: "manual-usage-sdk-identity",
        handleChatModelStart: (_serialized, _messages, modelCallId) => {
          this.sdkStarts.push(modelCallId);
        },
        handleLLMEnd: (_output, modelCallId) => {
          this.sdkEnds.push(modelCallId);
        },
      },
    ];
  }

  override async _generate(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    options?.signal?.throwIfAborted();
    this.requests.push(messages);
    if (this.requests.length === 1) {
      // 公开 native.streamEvents 的 seed 请求，独立于下面的维护 operation。
      return {
        generations: [
          { text: "seed 完成", message: new AIMessage("seed 完成") },
        ],
      };
    }
    if (this.requests.length !== 2)
      throw new Error("手动摘要 tracer 收到额外模型请求。");
    return {
      generations: [
        {
          text: SUMMARY_TEXT,
          message: new AIMessage<StandardMessageStructure>({
            id: "manual-summary-response",
            content: SUMMARY_TEXT,
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_token_details: { cache_read: 4 },
            },
          }),
        },
      ],
    };
  }
}

async function seedNativeHistory(harness: Harness) {
  const saved = await harness.persistence.getPersistence();
  if (!saved)
    throw new Error("手动用量 tracer 未装配真实 native persistence。");
  const native = createKenFutWorkDeepAgent({
    env: harness.env,
    model: harness.model,
    preset: "code",
    systemPrompt: "手动压缩真实历史",
    backendResult: {
      factory: () => harness.handle.backend,
      sandboxDir: harness.scope.rootDirectory,
      ephemeral: false,
    },
    ...saved,
  });
  const history = Array.from(
    { length: 30 },
    (_, index): BaseMessage =>
      index % 2
        ? new AIMessage({ id: `seed-ai-${index}`, content: `AI事实 ${index}` })
        : new HumanMessage({
            id: `seed-user-${index}`,
            content: `用户事实 ${index}`,
          }),
  );
  for await (const _event of native.streamEvents(
    { messages: history },
    { version: "v2", configurable: { thread_id: harness.threadId } },
  )) {
  }
  const context = native.contextHistory;
  const before = await context?.captureCurrentReference(harness.threadId);
  if (!context || !before)
    throw new Error("30条消息未成为真实 native checkpoint。");
  const original = await context.getEffectiveState(before);
  expect(original.messages).toHaveLength(31);
  expect(original.messages.filter((message) => message.summary)).toEqual([]);
  expect(original.messages.slice(0, 30).map((message) => message.id)).toEqual(
    history.map((message) => message.id),
  );
  return { context, before, original };
}

async function runManualCompact(harness: Harness) {
  const runId = randomUUID();
  await harness.service.createAcceptedRun({
    runId,
    sessionId: harness.scope.taskId,
    threadId: harness.threadId,
  });
  harness.runtime.createRun(
    {
      sessionId: harness.scope.taskId,
      conversationId: harness.scope.taskId,
      taskId: harness.scope.taskId,
      projectId: harness.scope.projectId,
      preset: "code",
      prompt: "",
    },
    {
      runId,
      threadId: harness.threadId,
      scopeHandle: harness.handle,
      actor: harness.actor,
      operation: { kind: "compact" },
      inputOrigin: "controlOperation",
      inputIdentity: {
        clientId: "manual-usage-client",
        sourceCommandId: "manual-usage-command",
      },
    },
  );
  const events: StreamEvent[] = [];
  for await (const event of harness.runtime.streamRun(runId))
    events.push(event);
  return { runId, events };
}

async function assertNativeSummary(
  harness: Harness,
  seed: Awaited<ReturnType<typeof seedNativeHistory>>,
  runId: string,
) {
  const after = await seed.context.captureCurrentReference(harness.threadId);
  if (!after) throw new Error("维护 operation 未返回真实已提交 native 引用。");
  expect(after).not.toEqual(seed.before);
  const compacted = await seed.context.getEffectiveState(after);
  const summaries = compacted.messages.filter((message) => message.summary);
  expect(summaries).toHaveLength(1);
  expect(JSON.stringify(summaries[0]?.content)).toContain(SUMMARY_TEXT);
  expect(compacted.messages.length).toBeLessThan(seed.original.messages.length);
  expect(await seed.context.getEffectiveState(seed.before)).toEqual(
    seed.original,
  );

  const boundaries = await harness
    .metadata()
    .getOwnedTurnBoundaries(harness.actor, {
      taskId: harness.scope.taskId,
      runId,
    });
  expect(boundaries.pre).toMatchObject({
    runId,
    operation: { kind: "compact" },
    inputOrigin: "controlOperation",
    inputMessageId: null,
    context: { status: "captured", reference: seed.before },
  });
  expect(boundaries.post).toMatchObject({
    runId,
    operation: { kind: "compact" },
    inputOrigin: "controlOperation",
    inputMessageId: null,
    context: { status: "captured", reference: after },
  });
}

/** 隔离真实 PG/Task/Scope/Harness/native summary；仅模型生成返回值受控。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "手动compact实际模型用量 integration",
  () => {
    it("summary只请求一次，真实SDK call用量10/3/cache4到达事件和Run账本", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const model = new ManualUsageModel();
        const runUsage = createRunUsageAccumulator();
        const harness = await createHarness(database, model, undefined, true, {
          runUsage,
        });
        work = harness.work;
        const seed = await seedNativeHistory(harness);
        expect(model.requests).toHaveLength(1);
        expect(model.sdkStarts).toHaveLength(1);
        expect(model.sdkEnds).toEqual(model.sdkStarts);
        const seededRequests = model.requests.length;
        const seededStarts = model.sdkStarts.length;
        const seededEnds = model.sdkEnds.length;
        const { runId, events } = await runManualCompact(harness);

        expect(events.at(-1)).toMatchObject({
          type: "run.completed",
          runId,
          operationResult: {
            kind: "compact",
            origin: "manual",
            status: "applied",
          },
        });
        expect(
          events.filter((event) => event.type.startsWith("message.")),
        ).toEqual([]);
        expect(
          events.filter((event) => event.type === "run.compacted"),
        ).toEqual([expect.objectContaining({ runId, origin: "manual" })]);
        expect(model.requests.length - seededRequests).toBe(1);
        expect(
          JSON.stringify(
            model.requests.at(-1)?.map((message) => message.content),
          ),
        ).toContain("用户事实 0");
        const sdkCalls = model.sdkStarts.slice(seededStarts);
        expect(sdkCalls).toHaveLength(1);
        expect(model.sdkEnds.slice(seededEnds)).toEqual(sdkCalls);
        const modelCallId = sdkCalls[0];
        if (!modelCallId) throw new Error("缺少真实SDK模型调用身份。");
        expect(modelCallId).not.toBe(runId);
        await assertNativeSummary(harness, seed, runId);
        expect(harness.runtime.hasActiveRunForTask(harness.scope.taskId)).toBe(
          false,
        );

        const usageEvents = events.filter(
          (event) => event.type === "run.usage",
        );
        expect(usageEvents).toHaveLength(1);
        expect.soft(usageEvents[0]).toMatchObject({
          runId,
          modelCallId,
          inputTokens: 10,
          outputTokens: 3,
          cachedInputTokens: 4,
          runInputTokens: 10,
          runOutputTokens: 3,
          runCachedInputTokens: 4,
        });
        expect.soft(runUsage.take(runId)).toEqual([
          {
            provider: "builtin",
            model: String(model),
            instanceId: harness.actor.instanceId,
            accessClientId: harness.actor.accessClientId,
            inputTokens: 10,
            outputTokens: 3,
            cachedInputTokens: 4,
          },
        ]);
        expect(runUsage.take(runId)).toEqual([]);
        expect(model.requests.length - seededRequests).toBe(1);
      } finally {
        try {
          await work?.close("test cleanup");
        } finally {
          await database.close();
        }
      }
    }, 90_000); // 独占PG/Task/native graph的测试同步期限，非Agent运行时治理值。
  },
);
