import { randomUUID } from "node:crypto";
import type { ModelCallPurpose } from "@kenfutwork/shared";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { expect, it, vi } from "vitest";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { createRunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import { createRunModelCallbacks } from "./model-observation.js";
import { createRunModelRequestPort } from "./model-request.js";

async function requestFixture() {
  const provider = await heldModel({
    usage: { promptTokens: 31, completionTokens: 4 },
  });
  const starts: {
    id: string;
    purpose: ModelCallPurpose;
    messages: BaseMessage[][];
  }[] = [];
  const ends: string[] = [];
  const errors: string[] = [];
  const receipts: string[] = [];
  const providerId = randomUUID();
  const runId = randomUUID();
  const usage = createRunUsageAccumulator();
  const controller = new AbortController();
  const port = createRunModelRequestPort({
    actor: { instanceId: randomUUID(), accessClientId: null },
    runId,
    sessionId: randomUUID(),
    threadId: undefined,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    usage,
    catalog: undefined,
    now: () => new Date().toISOString(),
    assertCurrent: () => {},
    publish: async (event) => {
      if (!event.modelCallId) throw new Error("用量缺少调用身份");
      receipts.push(event.modelCallId);
    },
    providers: {
      resolveCredentials: async () => ({
        instanceId: providerId,
        name: "local",
        protocol: "openai-compatible",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key-not-context",
        configRevision: 3,
        models: [],
      }),
    },
    createModelCallbacks: (kind) =>
      createRunModelCallbacks(
        [
          {
            preset: "shared",
            createMiddleware: () => ({ name: "IndependentObserver" }),
            createModelCallbacks(_identity, _context, purpose) {
              if (!purpose) throw new Error("请求缺少用途");
              const observed = BaseCallbackHandler.fromMethods({
                handleChatModelStart(_model, messages, id) {
                  starts.push({ id, purpose, messages });
                },
                handleLLMEnd(_result, id) {
                  ends.push(id);
                },
                handleLLMError(_error, id) {
                  errors.push(id);
                },
              });
              observed.awaitHandlers = true;
              return [observed];
            },
          },
        ],
        {},
        undefined,
        kind,
      ),
  });
  const request = {
    invocation: {
      providerId,
      modelId: "observed-model",
      configRevision: 3,
      useResponsesApi: false,
      body: { max_tokens: 100 },
      inputCapabilities: { image: false, pdf: false },
    },
    system: "独立评估规则",
    input: "实际操作证据",
    remainingTokens: null,
  };
  return {
    provider,
    starts,
    ends,
    errors,
    receipts,
    usage,
    runId,
    request,
    port,
    async close() {
      controller.abort();
      await provider.close();
    },
  };
}

it.each(["goal-evaluation", "approval-review"] as const)(
  "独立 %s 请求沿真实SDK回调记录且用量身份一致",
  async (purpose) => {
    const f = await requestFixture();
    const { provider, starts, ends, receipts } = f;
    try {
      const pending = f.port({ ...f.request, purpose });
      await Promise.race([provider.firstRequest, pending]);
      provider.finish(0);
      expect(await pending).toEqual({
        text: "正在运行 1",
        hasToolCalls: false,
        usageObserved: true,
        finishReason: "stop",
      });
      expect(starts.map((r) => r.purpose)).toEqual([purpose]);
      expect(starts).toHaveLength(1);
      const start = starts[0];
      if (!start) throw new Error("没有独立请求观察记录");
      expect(start.messages[0]?.map((message) => message.content)).toEqual([
        "独立评估规则",
        "实际操作证据",
      ]);
      expect(provider.requests[0]?.body.messages).toEqual([
        { role: "system", content: "独立评估规则" },
        { role: "user", content: "实际操作证据" },
      ]);
      expect(provider.requests[0]?.body.tools).toBeUndefined();
      expect(ends).toEqual([start.id]);
      expect(receipts).toEqual([start.id]);
    } finally {
      await f.close();
    }
  },
);

it("同Run并发评估反向结束时保留各自用途和调用身份", async () => {
  const f = await requestFixture();
  try {
    const first = f.port({ ...f.request, purpose: "goal-evaluation" });
    await Promise.race([f.provider.firstRequest, first]);
    const second = f.port({ ...f.request, purpose: "approval-review" });
    await vi.waitFor(() => expect(f.provider.requests).toHaveLength(2));
    f.provider.finish(1);
    expect((await second).text).toBe("正在运行 2");
    f.provider.finish(0);
    expect((await first).text).toBe("正在运行 1");
    expect(f.starts.map((r) => r.purpose)).toEqual([
      "goal-evaluation",
      "approval-review",
    ]);
    expect(new Set(f.starts.map((r) => r.id)).size).toBe(2);
    expect(f.ends).toEqual([f.starts[1]?.id, f.starts[0]?.id]);
    expect(f.receipts).toEqual(f.ends);
    expect(f.usage.take(f.runId)).toMatchObject([
      { inputTokens: 62, outputTokens: 8 },
    ]);
  } finally {
    await f.close();
  }
});

it("独立取消记录失败且不产生用量，同Run后续请求仍可完成", async () => {
  const f = await requestFixture();
  const caller = new AbortController();
  try {
    const pending = f.port({
      ...f.request,
      purpose: "goal-evaluation",
      signal: caller.signal,
    });
    await Promise.race([f.provider.firstRequest, pending]);
    caller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.errors).toEqual([f.starts[0]?.id]));
    expect(f.ends).toEqual([]);
    expect(f.receipts).toEqual([]);
    const next = f.port({ ...f.request, purpose: "approval-review" });
    await vi.waitFor(() => expect(f.provider.requests).toHaveLength(2));
    f.provider.finish(1);
    expect((await next).usageObserved).toBe(true);
    expect(f.ends).toEqual([f.starts[1]?.id]);
    expect(f.receipts).toEqual(f.ends);
    expect(f.errors).toEqual([f.starts[0]?.id]);
  } finally {
    await f.close();
  }
});
