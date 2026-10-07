import type { ProviderInstanceResponse } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createLocalInstanceService } from "../local-instance/service.js";
import {
  createModelCatalogService,
  parseInstanceSpecifier,
  toInstanceSpecifier,
} from "./model-catalog-service.js";
import { buildModelsDevSnapshot } from "./models-dev-snapshot.js";

const actor = { instanceId: "local-1", accessClientId: "desktop" };
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => actor.instanceId },
  dataDir: "/tmp/catalog-test",
});

function instance(
  overrides: Partial<ProviderInstanceResponse> = {},
): ProviderInstanceResponse {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    scope: "local",
    name: "我的网关",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 1,
    models: [
      { id: "gpt-x", name: "GPT X", capability: "chat" },
      { id: "img-1", name: "IMG 1", capability: "image" },
    ],
    headerKeys: [],
    enabled: true,
    ...overrides,
  };
}

describe("modelCatalog（目录推导）", () => {
  it("从启用实例推导目录条目，禁用实例被跳过", async () => {
    const catalog = createModelCatalogService({
      localInstance,
      modelProviders: {
        listInstances: async () => [
          instance(),
          instance({
            id: "22222222-2222-2222-2222-222222222222",
            name: "停用实例",
            enabled: false,
          }),
        ],
      },
    });
    const entries = await catalog.listCatalog(actor);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider.instanceId === instance().id)).toBe(
      true,
    );
    expect(entries.map((e) => e.capability).sort()).toEqual(["chat", "image"]);
    expect(entries.every((e) => e.provider.scope === "local")).toBe(true);
  });

  it("空实例列表返回空目录", async () => {
    const catalog = createModelCatalogService({
      localInstance,
      modelProviders: {
        listInstances: async () => [],
      },
    });
    expect(await catalog.listCatalog(actor)).toEqual([]);
  });

  it("拒绝其他实例 Actor，目录故障不会被平台池降级掩盖", async () => {
    const listInstances = vi.fn(async () => [instance()]);
    const catalog = createModelCatalogService({
      localInstance,
      modelProviders: { listInstances },
    });
    await expect(
      catalog.listCatalog({ instanceId: "foreign", accessClientId: "desktop" }),
    ).rejects.toMatchObject({ code: "instance_forbidden" });
    expect(listInstances).not.toHaveBeenCalled();
    const failure = new Error("目录存储失败");
    listInstances.mockRejectedValueOnce(failure);
    await expect(catalog.listCatalog(actor)).rejects.toBe(failure);
  });

  it("模型级停用过滤，完整配置快照仍保留停用条目且无凭据", async () => {
    const models = [
      { id: "on", name: "启用", capability: "chat" as const },
      { id: "off", name: "停用", capability: "chat" as const, enabled: false },
    ];
    const configured = instance({ models });
    const catalog = createModelCatalogService({
      localInstance,
      modelProviders: { listInstances: async () => [configured] },
    });
    expect((await catalog.listCatalog(actor)).map((entry) => entry.id)).toEqual(
      ["on"],
    );
    expect(
      catalog.describeInstanceModels([configured]).map((entry) => entry.id),
    ).toEqual(["on", "off"]);
    expect(
      JSON.stringify(catalog.describeInstanceModels([configured])),
    ).not.toContain("apiKey");
  });
});

describe("modelCatalog 快照 hints（三层合并）", () => {
  // 快照 fixture：openai 下有 gpt-x（上下文/工具/图像输入）、img-1（输出 video 的生成模型）；
  // anthropic 下同 id gpt-x 用于验证协议偏好。
  const snapshot = buildModelsDevSnapshot(
    {
      openai: {
        models: {
          "gpt-x": {
            id: "gpt-x",
            name: "GPT X",
            tool_call: true,
            reasoning: false,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 400000, output: 32000 },
          },
          "img-1": {
            id: "img-1",
            name: "IMG 1",
            modalities: { input: ["text"], output: ["image"] },
          },
        },
      },
      anthropic: {
        models: {
          "gpt-x": {
            id: "gpt-x",
            name: "同名不同家",
            tool_call: false,
            limit: { context: 1000 },
          },
        },
      },
    },
    ["openai", "anthropic"],
  ).snapshot;

  function catalogWith(models: ProviderInstanceResponse["models"]) {
    return createModelCatalogService({
      localInstance,
      modelProviders: {
        listInstances: async () => [instance({ models })],
      },
      snapshot,
    });
  }

  it("未声明字段由快照补缺，出处（snapshotProvider）透出", async () => {
    const catalog = catalogWith([
      { id: "gpt-x", name: "GPT X", capability: "chat" },
    ]);
    const [entry] = await catalog.listCatalog(actor);
    expect(entry?.hints).toEqual({
      source: "models-dev",
      snapshotProvider: "openai",
      contextWindow: 400000,
      maxOutputTokens: 32000,
      imageInput: true,
      toolCall: true,
      reasoning: false,
    });
    // 模型行保持原样（原始实例声明，不被快照污染）
    expect(entry?.model.contextWindow).toBeUndefined();
    expect(entry?.model.vision).toBeUndefined();
  });

  it("用户声明优先：声明过的字段绝不进 hints（无双源）", async () => {
    const catalog = catalogWith([
      {
        id: "gpt-x",
        name: "GPT X",
        capability: "chat",
        vision: false,
        contextWindow: 8000,
      },
    ]);
    const [entry] = await catalog.listCatalog(actor);
    expect(entry?.hints).toEqual({
      source: "models-dev",
      snapshotProvider: "openai",
      maxOutputTokens: 32000,
      toolCall: true,
      reasoning: false,
    });
    expect(entry?.model.contextWindow).toBe(8000);
    expect(entry?.model.vision).toBe(false);
  });

  it("快照未收录的模型 → 无 hints（未知 ≠ 不支持）", async () => {
    const catalog = catalogWith([
      { id: "my-private-model", name: "私有模型", capability: "chat" },
    ]);
    const [entry] = await catalog.listCatalog(actor);
    expect(entry?.hints).toBeUndefined();
  });

  it("openai-compatible 实例的同名模型偏好 openai 快照，anthropic 实例偏好 anthropic", async () => {
    const openaiCatalog = catalogWith([
      { id: "gpt-x", name: "G", capability: "chat" },
    ]);
    const [openaiEntry] = await openaiCatalog.listCatalog(actor);
    expect(openaiEntry?.hints?.snapshotProvider).toBe("openai");
    expect(openaiEntry?.hints?.contextWindow).toBe(400000);

    const anthropicCatalog = createModelCatalogService({
      localInstance,
      modelProviders: {
        listInstances: async () => [
          instance({
            models: [{ id: "gpt-x", name: "G", capability: "chat" }],
            protocol: "anthropic",
          }),
        ],
      },
      snapshot,
    });
    const [anthropicEntry] = await anthropicCatalog.listCatalog(actor);
    expect(anthropicEntry?.hints?.snapshotProvider).toBe("anthropic");
    expect(anthropicEntry?.hints?.contextWindow).toBe(1000);
  });

  it("不传快照 → 全部条目无 hints，目录照常（fail-open）", async () => {
    const catalog = createModelCatalogService({
      localInstance,
      modelProviders: {
        listInstances: async () => [instance()],
      },
    });
    const entries = await catalog.listCatalog(actor);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.hints === undefined)).toBe(true);
  });
});

describe("实例 specifier 约定", () => {
  it("目录条目生成 `<instanceId>:<modelId>`", () => {
    const entry = instance().models[0];
    if (!entry) {
      throw new Error("桩实例未定义模型");
    }
    expect(
      toInstanceSpecifier({
        provider: { instanceId: instance().id },
        id: entry.id,
      }),
    ).toBe(`${instance().id}:gpt-x`);
  });

  it("parse：uuid 前缀识别为实例 specifier，内置协议前缀与裸模型名不识别", () => {
    const instanceId = "11111111-1111-1111-1111-111111111111";
    expect(parseInstanceSpecifier(`${instanceId}:gpt-x`)).toEqual({
      instanceId,
      model: "gpt-x",
    });
    expect(parseInstanceSpecifier("openai:gpt-4.1")).toBeUndefined();
    expect(parseInstanceSpecifier("google:gemini-2.5-flash")).toBeUndefined();
    expect(parseInstanceSpecifier("gpt-4.1")).toBeUndefined();
    expect(parseInstanceSpecifier(`${instanceId}:`)).toBeUndefined();
    expect(parseInstanceSpecifier(":m")).toBeUndefined();
  });
});
