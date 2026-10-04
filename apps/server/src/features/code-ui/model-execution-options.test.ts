import { randomUUID } from "node:crypto";
import { providerInstanceResponseSchema } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { compileCodeUiModelExecution } from "./model-execution-options.js";
import { buildCodeUiModelViews } from "./model-views.js";

function fixture(
  reasoningMap = 'reasoningLevel == "low" ? {"thinking": {"enabled": false, "legacy": null}} : {"thinking": {"enabled": true}}',
  outputMap = '{"max_tokens": maxOutputTokens}',
) {
  const extraBody = {
    thinking: { enabled: true, legacy: 7, preserved: "value" },
    untouchedNull: null,
    flag: false,
  };
  const instance = providerInstanceResponseSchema.parse({
    id: randomUUID(),
    scope: "workspace",
    name: "实际实例",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 7,
    headerKeys: [],
    enabled: true,
    models: [
      {
        id: "model",
        name: "Model",
        capability: "chat",
        contextWindow: 8192,
        maxOutputTokens: 512,
        vision: false,
        inputModalities: ["text", "pdf"],
        reasoningEfforts: ["low", "high"],
        extraBody,
      },
    ],
    compat: {
      codeUi: {
        models: {
          model: {
            useRecommendedConfig: true,
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["low", "high"], map: reasoningMap },
                maxOutputTokens: { max: 512, map: outputMap },
              },
            },
          },
        },
      },
    },
  });
  const selection = {
    providerId: instance.id,
    modelId: "model",
    options: { reasoningLevel: "low" },
  };
  return {
    instance,
    selection,
    extraBody,
    input: { instances: [instance], catalog: [], selection },
  };
}
it("原option maps冻结所选档位和输出上限，RFC7386保留false与未改null、删除patch null", () => {
  const { input, instance, extraBody } = fixture();
  const snapshot = compileCodeUiModelExecution(input);
  expect(snapshot).toMatchObject({
    providerId: instance.id,
    modelId: "model",
    configRevision: 7,
    inputCapabilities: { image: false, pdf: true },
    body: {
      thinking: { enabled: false, preserved: "value" },
      untouchedNull: null,
      flag: false,
      max_tokens: 512,
    },
  });
  expect(snapshot.body.thinking).not.toHaveProperty("legacy");
  expect(extraBody.thinking).toEqual({
    enabled: true,
    legacy: 7,
    preserved: "value",
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.body)).toBe(true);
  expect(Object.isFrozen(snapshot.body.thinking)).toBe(true);
});
it("UI与执行使用同一配置真相；Run快照不随后续模型编辑或extraBody修改改变", () => {
  const { input, instance } = fixture();
  const before = compileCodeUiModelExecution(input);
  const views = buildCodeUiModelViews(input);
  expect(
    views.settings.providers[0]?.models[0]?.effectiveConfig.optionSpecs
      ?.maxOutputTokens?.max,
  ).toBe(before.body.max_tokens);
  instance.configRevision++;
  instance.models[0]!.maxOutputTokens = 1024;
  instance.models[0]!.extraBody = { changed: true };
  const after = compileCodeUiModelExecution(input);
  expect(before.body.max_tokens).toBe(512);
  expect(before.configRevision).toBe(7);
  expect(after.body.max_tokens).toBe(1024);
  expect(after.configRevision).toBe(8);
});
it("无选择/explicit null/缺档位/非法档位都拒绝，不选择最高或替代供应商", () => {
  const { input, instance } = fixture();
  for (const selection of [
    null,
    undefined,
    { providerId: instance.id, modelId: "model" },
    {
      providerId: instance.id,
      modelId: "model",
      options: { reasoningLevel: "invalid" },
    },
  ]) {
    expect(() =>
      compileCodeUiModelExecution({ ...input, selection }),
    ).toThrow();
  }
});
it("供应商/模型资格变化拒绝，静态或map参数都不能偷换模型或凭证", () => {
  const { input, instance } = fixture();
  instance.hasCredential = false;
  expect(() => compileCodeUiModelExecution(input)).toThrow("凭证");
  instance.hasCredential = true;
  instance.models[0]!.enabled = false;
  expect(() => compileCodeUiModelExecution(input)).toThrow("停用");
  instance.models[0]!.enabled = true;
  instance.models[0]!.extraBody = { model: "other" };
  expect(() => compileCodeUiModelExecution(input)).toThrow("请求身份");
  expect(() =>
    compileCodeUiModelExecution(fixture('{"apiKey": "replacement"}').input),
  ).toThrow("凭证字段");
});
it("原DSL非法源码或两份map冲突不发出部分请求参数", () => {
  expect(() =>
    compileCodeUiModelExecution(
      fixture('{"shared": 1}', '{"shared": maxOutputTokens}').input,
    ),
  ).toThrow("conflicting");
  expect(() => fixture("process.env.KEY")).toThrow();
});
it("Gemini默认不编造thinking预算，声明的Gemini3档位才使用真实thinkingLevel", () => {
  const instance = providerInstanceResponseSchema.parse({
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
        maxOutputTokens: 2048,
      },
    ],
  });
  const base = { instances: [instance], catalog: [] };
  const ordinary = compileCodeUiModelExecution({
    ...base,
    selection: {
      providerId: instance.id,
      modelId: "gemini-2.5-flash",
      options: { reasoningLevel: "default" },
    },
  });
  expect(ordinary.body).toEqual({
    generationConfig: { maxOutputTokens: 2048 },
  });
  expect(ordinary.body).not.toHaveProperty("thinkingConfig");
  instance.models = [
    {
      id: "gemini-3-flash",
      name: "Flash 3",
      capability: "chat",
      reasoningEfforts: ["low", "high"],
      maxOutputTokens: 4096,
    },
  ];
  expect(
    compileCodeUiModelExecution({
      ...base,
      selection: {
        providerId: instance.id,
        modelId: "gemini-3-flash",
        options: { reasoningLevel: "low" },
      },
    }).body,
  ).toEqual({
    generationConfig: {
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  instance.models = [
    {
      id: "gemini-2.5-pro",
      name: "Pro",
      capability: "chat",
      reasoningEfforts: ["low", "high"],
    },
  ];
  expect(() =>
    compileCodeUiModelExecution({
      ...base,
      selection: {
        providerId: instance.id,
        modelId: "gemini-2.5-pro",
        options: { reasoningLevel: "high" },
      },
    }),
  ).toThrow("配置不完整");
});
