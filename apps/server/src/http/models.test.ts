import type { ModelCatalogEntry } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerEnv } from "../config/env.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import { registerModelRoutes } from "./models.js";

const actor: LocalActor = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  accessClientId: "00000000-0000-4000-8000-000000000009",
};

const localAccess: LocalAccessVerifier = {
  authenticate: async () => actor,
};

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "gpt-x",
    name: "GPT X",
    capability: "chat",
    model: { id: "gpt-x", name: "GPT X", capability: "chat" },
    provider: {
      instanceId: "11111111-1111-1111-1111-111111111111",
      name: "我的网关",
      protocol: "openai-compatible",
      scope: "local",
    },
    ...overrides,
  };
}

async function buildApp(catalogEntries: ModelCatalogEntry[]) {
  const app = Fastify();
  await app.register(registerModelRoutes, {
    env: {} as ServerEnv,
    localAccess,
    modelCatalog: {
      describeInstanceModels: () => catalogEntries,
      listCatalog: async () => catalogEntries,
      validateSpecifier: async () => ({ ok: true }),
    },
  });
  return app;
}

describe("GET /api/models（BYOK 目录并入 + hints 摊平）", () => {
  afterAll(async () => {
    await Fastify().close();
  });

  it("hints 补缺字段摊平进模型行（vision/contextWindow/maxOutputTokens）", async () => {
    const app = await buildApp([
      entry({
        hints: {
          source: "models-dev",
          snapshotProvider: "openai",
          contextWindow: 400000,
          maxOutputTokens: 32000,
          imageInput: true,
          toolCall: true,
        },
      }),
    ]);
    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(200);
    const model = response.json().models.at(0);
    expect(model).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111:gpt-x",
      vision: true,
      contextWindow: 400000,
      maxOutputTokens: 32000,
      providerName: "我的网关",
    });
    // hints 本身不外发（摊平语义，双源不进 API 面）
    expect(model).not.toHaveProperty("hints");
  });

  it("用户声明优先于 hints（声明值胜出，快照不覆盖）", async () => {
    const app = await buildApp([
      entry({
        model: {
          id: "gpt-x",
          name: "GPT X",
          capability: "chat",
          vision: false,
          contextWindow: 8000,
        },
        hints: {
          source: "models-dev",
          snapshotProvider: "openai",
          contextWindow: 400000,
          imageInput: true,
        },
      }),
    ]);
    const response = await app.inject({ method: "GET", url: "/api/models" });
    const model = response.json().models.at(0);
    expect(model?.contextWindow).toBe(8000);
    expect(model?.vision).toBeUndefined();
  });

  it("无 hints 且无声明的条目：不带视觉/上下文字段（未知不伪装）", async () => {
    const app = await buildApp([entry({})]);
    const response = await app.inject({ method: "GET", url: "/api/models" });
    const model = response.json().models.at(0);
    expect(model).not.toHaveProperty("vision");
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("maxOutputTokens");
  });

  it("非 chat 条目（image/video）不进对话模型列表", async () => {
    const app = await buildApp([
      entry({ id: "img-1", name: "IMG", capability: "image" }),
    ]);
    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.json().models).toHaveLength(0);
  });
});
