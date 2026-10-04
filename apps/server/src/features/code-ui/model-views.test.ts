import { randomUUID } from "node:crypto";
import { providerInstanceResponseSchema } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { buildCodeUiModelViews } from "./model-views.js";

function provider(input: Record<string, unknown> = {}) {
  return providerInstanceResponseSchema.parse({
    id: randomUUID(),
    scope: "workspace",
    name: "Google",
    protocol: "gemini",
    hasCredential: true,
    configRevision: 1,
    headerKeys: [],
    enabled: true,
    models: [
      {
        id: "gemini-2.5-flash",
        name: "Flash",
        capability: "chat",
        inputModalities: ["text", "image", "pdf"],
      },
    ],
    ...input,
  });
}
it("Gemini保留真实原生协议和输入模态，view永远无Key或header值", () => {
  const instance = provider({ headerKeys: ["x-workspace"] });
  const views = buildCodeUiModelViews({ instances: [instance], catalog: [] });
  expect(views.settings.providers[0]).toMatchObject({
    credentialConfigured: true,
    configRevision: 1,
    effectiveConfig: {
      access: { type: "api-key" },
      api: { type: "google-generative-language" },
    },
    models: [
      {
        executable: true,
        effectiveConfig: {
          properties: {
            inputFormat: { supportsImage: true, supportsPdf: true },
          },
        },
      },
    ],
  });
  expect(views.selection.providers[0]?.config.api?.type).toBe(
    "google-generative-language",
  );
  expect(JSON.stringify(views)).not.toContain('"apiKey":');
  expect(JSON.stringify(views)).not.toContain('"headers":');
});
it("无Key/无模型draft仍真实显示，只读presence不会使其进入模型选择", () => {
  const instance = provider({ hasCredential: false, models: [] });
  const views = buildCodeUiModelViews({ instances: [instance], catalog: [] });
  expect(views.settings.providers).toEqual([
    expect.objectContaining({
      providerId: instance.id,
      credentialConfigured: false,
      executable: false,
      models: [],
    }),
  ]);
  expect(views.selection.providers).toEqual([]);
});
it("停用模型留在设置视图，已有选择/null/非法档位不会静默换供应商或补档位", () => {
  const instance = provider({
    protocol: "openai-compatible",
    models: [
      {
        id: "active",
        name: "Active",
        capability: "chat",
        reasoningEfforts: ["low", "high"],
      },
      { id: "disabled", name: "Disabled", capability: "chat", enabled: false },
    ],
  });
  const base = { instances: [instance], catalog: [] };
  expect(buildCodeUiModelViews(base).settings.providers[0]?.models).toEqual([
    expect.objectContaining({ modelId: "active", executable: true }),
    expect.objectContaining({
      modelId: "disabled",
      enabled: false,
      executable: false,
    }),
  ]);
  expect(
    buildCodeUiModelViews({ ...base, selection: null }).selection,
  ).toMatchObject({
    effectiveSelection: null,
    selectionIssue: "selection-missing",
  });
  expect(
    buildCodeUiModelViews({
      ...base,
      selection: { providerId: instance.id, modelId: "active" },
    }).selection,
  ).toMatchObject({
    effectiveSelection: { providerId: instance.id, modelId: "active" },
    selectionIssue: "reasoning-level-missing",
  });
  expect(
    buildCodeUiModelViews({
      ...base,
      selection: {
        providerId: instance.id,
        modelId: "active",
        options: { reasoningLevel: "invalid" },
      },
    }).selection,
  ).toMatchObject({ selectionIssue: "reasoning-level-not-supported" });
  expect(
    buildCodeUiModelViews({
      ...base,
      selection: {
        providerId: instance.id,
        modelId: "disabled",
        options: { reasoningLevel: "high" },
      },
    }).selection.effectiveSelection,
  ).toBeNull();
});
it("原Responses配置按真实chatApi显示，显式false模态压过旧Code元数据", () => {
  const instance = provider({
    protocol: "openai-compatible",
    models: [
      {
        id: "model",
        name: "Model",
        capability: "chat",
        vision: false,
        inputModalities: ["text"],
        contextWindow: 8192,
      },
    ],
    compat: {
      chatApi: "responses",
      codeUi: {
        models: {
          model: {
            config: {
              properties: {
                contextWindow: 4096,
                inputFormat: { supportsImage: true, supportsPdf: true },
              },
            },
            useRecommendedConfig: true,
          },
        },
      },
    },
  });
  const views = buildCodeUiModelViews({ instances: [instance], catalog: [] });
  expect(views.settings.providers[0]?.effectiveConfig.api?.type).toBe(
    "openai-responses",
  );
  expect(
    views.settings.providers[0]?.models[0]?.effectiveConfig.properties,
  ).toMatchObject({
    contextWindow: 8192,
    inputFormat: { supportsImage: false, supportsPdf: false },
  });
});
