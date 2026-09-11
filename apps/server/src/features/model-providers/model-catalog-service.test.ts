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
    name: "我的网关",
    protocol: "openai-compatible",
    hasCredential: true,
    models: [
      { id: "gpt-x", name: "GPT X", capability: "chat" },
      { id: "img-1", name: "IMG 1", capability: "image" },
    ],
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
      } as never,
    });
    const entries = await catalog.listCatalog(user);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.provider.instanceId === instance().id)).toBe(
      true,
    );
    expect(entries.map((e) => e.capability).sort()).toEqual(["chat", "image"]);
  });

  it("空实例列表返回空目录", async () => {
    const catalog = createModelCatalogService({
      modelProviders: { listInstances: async () => [] } as never,
    });
    expect(await catalog.listCatalog(user)).toEqual([]);
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
