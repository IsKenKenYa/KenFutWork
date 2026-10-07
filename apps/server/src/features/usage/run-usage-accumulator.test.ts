import { describe, expect, it } from "vitest";

import {
  createRunUsageAccumulator,
  type RunUsageEntry,
} from "./run-usage-accumulator.js";

const callA: RunUsageEntry = {
  inputTokens: 10,
  outputTokens: 3,
  provider: "openai-compatible",
  model: "model-a",
  providerInstanceId: "provider-a",
  instanceId: "instance-1",
  accessClientId: "client-1",
};

describe("runUsageAccumulator（按模型调用累计绝对用量）", () => {
  it("同 call 的重复 stream/end 不重复相加，最终修正覆盖累计值", () => {
    const acc = createRunUsageAccumulator();
    const streamed = { ...callA, cachedInputTokens: 4, costUsd: 0.03 };
    expect(acc.update("run-1", "call-a", streamed)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 4,
    });
    expect(acc.update("run-1", "call-a", streamed)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 4,
    });
    expect(
      acc.update("run-1", "call-a", {
        ...callA,
        outputTokens: 7,
        cachedInputTokens: 2,
        costUsd: 0.07,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 7, cachedInputTokens: 2 });
    expect(
      acc.update("run-1", "call-a", {
        ...callA,
        outputTokens: 6,
        cachedInputTokens: 1,
        costUsd: 0.06,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 6, cachedInputTokens: 1 });
    expect(acc.take("run-1")).toEqual([
      { ...callA, outputTokens: 6, cachedInputTokens: 1, costUsd: 0.06 },
    ]);
  });

  it("两个 input 相同的真实 call 独立累计，再合并同归属桶", () => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", "call-read", callA);
    expect(
      acc.update("run-1", "call-answer", { ...callA, outputTokens: 7 }),
    ).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(acc.update("run-1", "call-read", callA)).toEqual({
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(acc.take("run-1")).toEqual([
      { ...callA, inputTokens: 20, outputTokens: 10 },
    ]);
  });

  it("A/B 分桶，迟到的 A end 仍修正 A，成本逐 call 覆盖后相加", () => {
    const acc = createRunUsageAccumulator();
    const callB: RunUsageEntry = {
      inputTokens: 10,
      outputTokens: 7,
      provider: "anthropic",
      model: "model-b",
      providerInstanceId: "provider-b",
      instanceId: "instance-1",
      accessClientId: "client-1",
      cachedInputTokens: 0,
      costUsd: 0.07,
    };
    acc.update("run-1", "call-a", { ...callA, costUsd: 0.03 });
    acc.update("run-1", "call-b", callB);
    expect(
      acc.update("run-1", "call-a", {
        ...callA,
        outputTokens: 4,
        costUsd: 0.04,
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 11, cachedInputTokens: 0 });
    acc.update("run-1", "call-a-2", { ...callA, costUsd: 0.02 });
    expect(acc.take("run-1")).toEqual([
      { ...callA, inputTokens: 20, outputTokens: 7, costUsd: 0.06 },
      callB,
    ]);
  });

  it.each([
    { providerInstanceId: "provider-other" },
    { instanceId: "instance-other" },
    { accessClientId: "client-other" },
  ])("同 provider/model 的不同实例或 actor 仍分桶：%j", (attribution) => {
    const acc = createRunUsageAccumulator();
    const other = { ...callA, ...attribution };
    acc.update("run-1", "call-a", callA);
    acc.update("run-1", "call-other", other);
    expect(acc.take("run-1")).toEqual([callA, other]);
  });

  it("缺失可选缓存/成本不编造零，也不删除同 call 已知值", () => {
    const acc = createRunUsageAccumulator();
    expect(acc.update("run-1", "call-a", callA)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(acc.take("run-1")).toEqual([callA]);
    acc.update("run-1", "call-a", {
      ...callA,
      cachedInputTokens: 4,
      costUsd: 0.05,
    });
    expect(
      acc.update("run-1", "call-a", { ...callA, outputTokens: 7 }),
    ).toEqual({ inputTokens: 10, outputTokens: 7, cachedInputTokens: 4 });
    expect(acc.take("run-1")).toEqual([
      { ...callA, outputTokens: 7, cachedInputTokens: 4, costUsd: 0.05 },
    ]);
  });

  it("缓存与成本显式零可修正先前的非零累计值", () => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", "call-a", {
      ...callA,
      cachedInputTokens: 4,
      costUsd: 0.05,
    });
    expect(
      acc.update("run-1", "call-a", {
        ...callA,
        cachedInputTokens: 0,
        costUsd: 0,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 });
    expect(acc.take("run-1")).toEqual([
      { ...callA, cachedInputTokens: 0, costUsd: 0 },
    ]);
  });

  it("run 隔离，take 完全清理并允许随后复用 call ID", () => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", "call-a", callA);
    acc.update("run-2", "call-a", { ...callA, outputTokens: 7 });
    expect(acc.take("run-1")).toEqual([callA]);
    expect(acc.take("run-1")).toEqual([]);
    expect(acc.take("run-absent")).toEqual([]);
    expect(acc.take("run-2")).toEqual([{ ...callA, outputTokens: 7 }]);
    const replacement = { ...callA, model: "replacement-model" };
    expect(acc.update("run-1", "call-a", replacement)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(acc.take("run-1")).toEqual([replacement]);
  });

  it("调用方改动输入或返回快照不会改写账本", () => {
    const acc = createRunUsageAccumulator();
    const entry = { ...callA };
    const totals = acc.update("run-1", "call-a", entry);
    entry.model = "mutated-model";
    entry.inputTokens = 999;
    totals.outputTokens = 999;
    expect(acc.update("run-1", "call-a", callA)).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(acc.take("run-1")).toEqual([callA]);
  });

  it.each(["", " ", "\t\n"])("拒绝空 runId/modelCallId：%j", (id) => {
    const acc = createRunUsageAccumulator();
    expect(() => acc.update(id, "call-a", callA)).toThrow("runId");
    expect(() => acc.update("run-1", id, callA)).toThrow("modelCallId");
    expect(() => acc.take(id)).toThrow("runId");
    expect(acc.take("run-1")).toEqual([]);
  });

  it.each([undefined, null])("拒绝缺失 runId/modelCallId：%j", (id) => {
    const acc = createRunUsageAccumulator();
    expect(() =>
      Reflect.apply(acc.update, undefined, [id, "call-a", callA]),
    ).toThrow("runId");
    expect(() =>
      Reflect.apply(acc.update, undefined, ["run-1", id, callA]),
    ).toThrow("modelCallId");
    expect(acc.take("run-1")).toEqual([]);
  });

  it.each([
    { inputTokens: -1 },
    { inputTokens: Number.NaN },
    { inputTokens: Number.POSITIVE_INFINITY },
    { inputTokens: 1.5 },
    { outputTokens: -1 },
    { outputTokens: Number.NaN },
    { outputTokens: Number.POSITIVE_INFINITY },
    { outputTokens: 1.5 },
    { cachedInputTokens: -1 },
    { cachedInputTokens: Number.NaN },
    { cachedInputTokens: Number.POSITIVE_INFINITY },
    { cachedInputTokens: 1.5 },
    { costUsd: -1 },
    { costUsd: Number.NaN },
    { costUsd: Number.POSITIVE_INFINITY },
  ])("拒绝非法用量且保留之前的有效调用：%j", (invalid) => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", "call-a", callA);
    expect(() =>
      acc.update("run-1", "call-a", { ...callA, ...invalid }),
    ).toThrow("[runUsage]");
    expect(acc.take("run-1")).toEqual([callA]);
  });

  it.each([
    { provider: "other-provider" },
    { model: "other-model" },
    { providerInstanceId: "other-provider-instance" },
    { instanceId: "other-instance" },
    { accessClientId: "other-client" },
    { accessClientId: null },
  ])("同 call 归属变动立即拒绝，不污染既有用量：%j", (attribution) => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", "call-a", callA);
    expect(() =>
      acc.update("run-1", "call-a", {
        ...callA,
        ...attribution,
        inputTokens: 30,
        outputTokens: 20,
      }),
    ).toThrow("attribution");
    expect(acc.take("run-1")).toEqual([callA]);
  });
});
