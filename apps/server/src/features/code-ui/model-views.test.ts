import { providerInstanceResponseSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { buildCodeUiModelViews } from "./model-views.js";

describe("Code 宿主供应商与模型 view", () => {
  it("已有凭证保持真实可用状态，所有返回配置都不包含 API key 或私密请求头值", () => {
    const instance = providerInstanceResponseSchema.parse({
      id: "provider-1",
      name: "4.5Air",
      scope: "workspace",
      protocol: "openai-compatible",
      baseUrl: "https://example.test/v1",
      hasCredential: true,
      enabled: true,
      headerKeys: ["Authorization"],
      models: [
        {
          id: "glm-4.5-air",
          name: "GLM 4.5 Air",
          capability: "chat",
          vision: false,
        },
      ],
    });
    const views = buildCodeUiModelViews({
      instances: [instance],
      catalog: [
        {
          id: "glm-4.5-air",
          name: "GLM 4.5 Air",
          capability: "chat",
          model: instance.models[0]!,
          provider: {
            instanceId: instance.id,
            name: instance.name,
            protocol: instance.protocol,
            scope: instance.scope,
          },
        },
      ],
    });

    expect(views.settings.providers[0]).toMatchObject({
      executable: true,
      enabled: true,
    });
    expect(views.settings.providers[0]?.effectiveConfig.access).toEqual({
      type: "api-key",
    });
    expect(JSON.stringify(views)).not.toContain("Authorization");
  });
});
