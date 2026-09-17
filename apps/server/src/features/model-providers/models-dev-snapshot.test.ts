import { describe, expect, it } from "vitest";
import {
  buildModelsDevSnapshot,
  modelsDevSnapshotSchema,
} from "./models-dev-snapshot.js";

function rawFixture() {
  return {
    openai: {
      name: "OpenAI",
      models: {
        "gpt-test": {
          id: "gpt-test",
          name: "GPT Test",
          tool_call: true,
          structured_output: true,
          attachment: true,
          reasoning: true,
          temperature: false,
          open_weights: false,
          release_date: "2025-08-07",
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 400000, output: 128000 },
          cost: { input: 1.25, output: 10, cache_read: 0.125 },
          // 以下字段不在投影范围，必须被丢弃
          description: "a very long description",
          family: "gpt",
          last_updated: "2025-09-01",
          knowledge: "2024-06",
        },
        "bad-model": "not-an-object",
      },
    },
    deepseek: {
      models: {
        "deepseek-chat": {
          id: "deepseek-chat",
          // name 缺失 → 回落 id
          tool_call: true,
          cost: { input: 0.27, weird: { nested: true } },
        },
      },
    },
    "not-in-whitelist": { models: { m: { id: "m", name: "M" } } },
    "provider-without-models": { name: "Empty" },
  };
}

describe("buildModelsDevSnapshot", () => {
  it("只保留白名单内的 provider，白名单外与无 models 的条目跳过", () => {
    const { snapshot } = buildModelsDevSnapshot(rawFixture(), ["openai", "deepseek", "provider-without-models"]);
    expect(Object.keys(snapshot).sort()).toEqual(["deepseek", "openai"]);
    expect(snapshot["not-in-whitelist"]).toBeUndefined();
    expect(snapshot.deepseek?.name).toBeUndefined();
  });

  it("字段投影：snake_case 改名 camelCase，投影外字段丢弃", () => {
    const { snapshot } = buildModelsDevSnapshot(rawFixture(), ["openai"]);
    const model = snapshot.openai?.models["gpt-test"];
    expect(model).toMatchObject({
      id: "gpt-test",
      name: "GPT Test",
      toolCall: true,
      structuredOutput: true,
      attachment: true,
      reasoning: true,
      temperature: false,
      openWeights: false,
      releaseDate: "2025-08-07",
    });
    expect(model).not.toHaveProperty("description");
    expect(model).not.toHaveProperty("family");
    expect(model).not.toHaveProperty("last_updated");
    expect(model).not.toHaveProperty("knowledge");
    expect(model).not.toHaveProperty("tool_call");
  });

  it("cost 只保留数值条目；非对象模型被跳过；name 缺失回落 id", () => {
    const { snapshot } = buildModelsDevSnapshot(rawFixture(), ["openai", "deepseek"]);
    expect(snapshot.openai?.models["gpt-test"]?.cost).toEqual({
      input: 1.25,
      output: 10,
      cache_read: 0.125,
    });
    expect(snapshot.openai?.models["bad-model"]).toBeUndefined();
    expect(snapshot.deepseek?.models["deepseek-chat"]?.cost).toEqual({ input: 0.27 });
    expect(snapshot.deepseek?.models["deepseek-chat"]?.name).toBe("deepseek-chat");
  });

  it("modalities 与 limit 的非字符串/非数值成员被过滤，全空则整字段缺省", () => {
    const { snapshot } = buildModelsDevSnapshot(
      {
        openai: {
          models: {
            a: { id: "a", name: "A", modalities: { input: ["text", 5], output: [] }, limit: {} },
            b: { id: "b", name: "B", modalities: { input: ["text"] }, limit: { context: "x", output: 8192 } },
            c: { id: "c", name: "C", modalities: { input: [], output: [42] } },
          },
        },
      },
      ["openai"],
    );
    expect(snapshot.openai?.models.a?.modalities).toEqual({ input: ["text"] });
    expect(snapshot.openai?.models.a?.limit).toBeUndefined();
    expect(snapshot.openai?.models.b?.limit).toEqual({ output: 8192 });
    expect(snapshot.openai?.models.b?.modalities).toEqual({ input: ["text"] });
    expect(snapshot.openai?.models.c?.modalities).toBeUndefined();
  });

  it("stats 数字正确：bytes 与实际序列化体积一致", () => {
    const raw = rawFixture();
    const { snapshot, stats } = buildModelsDevSnapshot(raw, ["openai", "deepseek"]);
    expect(stats.providersKept).toBe(2);
    expect(stats.providersDropped).toBe(Object.keys(raw).length - 2);
    expect(stats.modelsKept).toBe(2);
    expect(stats.bytes).toBe(Buffer.byteLength(JSON.stringify(snapshot), "utf8"));
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("裁剪产物通过自身 zod 契约（写盘前自检不抛）", () => {
    const { snapshot } = buildModelsDevSnapshot(rawFixture());
    expect(() => modelsDevSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("根不是对象时 fail loud（TypeError），空对象返回空快照", () => {
    expect(() => buildModelsDevSnapshot("[]")).toThrow(TypeError);
    expect(() => buildModelsDevSnapshot(null)).toThrow(TypeError);
    expect(() => buildModelsDevSnapshot([1, 2])).toThrow(TypeError);
    const { snapshot, stats } = buildModelsDevSnapshot({});
    expect(snapshot).toEqual({});
    expect(stats.providersKept).toBe(0);
    expect(stats.modelsKept).toBe(0);
  });

  it("zod 契约拒绝结构性损坏的快照（模型缺 id / cost 含非数值）", () => {
    expect(() =>
      modelsDevSnapshotSchema.parse({ openai: { models: { m: { name: "M" } } } }),
    ).toThrow();
    expect(() =>
      modelsDevSnapshotSchema.parse({
        openai: { models: { m: { id: "m", name: "M", cost: { input: "x" } } } },
      }),
    ).toThrow();
  });
});
