import type { ProviderInstanceResponse } from "@loomic/shared";
import { describe, expect, it } from "vitest";
import {
  createModelCatalogService,
  parseInstanceSpecifier,
  toInstanceSpecifier,
} from "./model-catalog-service.js";

const user = {
  accessToken: "token",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function instance(
  overrides: Partial<ProviderInstanceResponse> = {},
): ProviderInstanceResponse {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    scope: "workspace",
    name: "我的网关",
    protocol: "openai-compatible",
    hasCredential: true,
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
      modelProviders: {
        listInstances: async () => [
          instance(),
          instance({
            id: "22222222-2222-2222-2222-222222222222",
            name: "停用实例",
            enabled: false,
          }),
        ],
        listSystemInstances: async () => [],
      } as never,
    });
    const entries = await catalog.listCatalog(user);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider.instanceId === instance().id)).toBe(
      true,
    );
    expect(entries.map((e) => e.capability).sort()).toEqual(["chat", "image"]);
    expect(entries.every((e) => e.provider.scope === "workspace")).toBe(true);
  });

  it("空实例列表返回空目录", async () => {
    const catalog = createModelCatalogService({
      modelProviders: {
        listInstances: async () => [],
        listSystemInstances: async () => [],
      } as never,
    });
    expect(await catalog.listCatalog(user)).toEqual([]);
  });

  it("平台池（system）实例并入目录并标记 scope，供前端与计费区分", async () => {
    const catalog = createModelCatalogService({
      modelProviders: {
        listInstances: async () => [],
        listSystemInstances: async () => [
          instance({
            id: "33333333-3333-3333-3333-333333333333",
            scope: "system",
            name: "平台池",
            models: [{ id: "pool-model", name: "Pool", capability: "chat" }],
          }),
        ],
      } as never,
    });
    const entries = await catalog.listCatalog(user);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.provider.scope).toBe("system");
    expect(entries[0]!.provider.name).toBe("平台池");
  });

  it("平台池读取失败不拖垮用户自有目录（降级）", async () => {
    const catalog = createModelCatalogService({
      modelProviders: {
        listInstances: async () => [instance()],
        listSystemInstances: async () => {
          throw new Error("admin client missing");
        },
      } as never,
    });
    const entries = await catalog.listCatalog(user);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider.scope === "workspace")).toBe(true);
  });
});

describe("实例 specifier 约定", () => {
  it("目录条目生成 `<instanceId>:<modelId>`", () => {
    const entry = instance().models[0]!;
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
