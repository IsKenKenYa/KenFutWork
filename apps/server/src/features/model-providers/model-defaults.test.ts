import {
  type ModelCatalogEntry,
  modelDefaultsSchema,
} from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { validateModelDefaults } from "./model-defaults.js";

const providerId = "c0a03eb2-d58c-4637-9fda-c796230a751a";
const otherProviderId = "722f052b-fd06-458b-a231-e43bce5b6613";

function chatEntry(
  instanceId = providerId,
  id = "reviewer",
): ModelCatalogEntry {
  return {
    id,
    name: id,
    capability: "chat",
    model: { id, name: id, capability: "chat" },
    provider: {
      instanceId,
      name: "用户供应商",
      protocol: "openai-compatible",
      scope: "local",
    },
  };
}

const approvalDefaults = () =>
  modelDefaultsSchema.parse({
    chat: null,
    approval: { providerId, modelId: "reviewer" },
    image: { mode: "auto" },
    video: { mode: "auto" },
  });

it("人工审批不要求配置模型，独立审批模型可与对话使用不同供应商", () => {
  const defaults = approvalDefaults();
  expect(() =>
    validateModelDefaults({ ...defaults, approval: null }, []),
  ).not.toThrow();
  expect(() =>
    validateModelDefaults(
      {
        ...defaults,
        chat: { providerId: otherProviderId, modelId: "chat" },
      },
      [chatEntry(), chatEntry(otherProviderId, "chat")],
    ),
  ).not.toThrow();
});

it("审批候选必须是当前目录中的精确供应商及模型身份", () => {
  for (const entries of [
    [],
    [chatEntry(otherProviderId)],
    [chatEntry(providerId, "other-model")],
  ]) {
    expect(() => validateModelDefaults(approvalDefaults(), entries)).toThrow(
      "所选审批模型不可用，请重新选择。",
    );
  }
});

it("停用模型、生成模型与 Flow 连接不能充当审批模型", () => {
  const entry = chatEntry();
  const invalidEntries: ModelCatalogEntry[] = [
    { ...entry, model: { ...entry.model, enabled: false } },
    {
      ...entry,
      capability: "image",
      model: { ...entry.model, capability: "image" },
    },
    {
      ...entry,
      provider: { ...entry.provider, protocol: "dify-engine" },
    },
  ];
  for (const invalid of invalidEntries) {
    expect(() => validateModelDefaults(approvalDefaults(), [invalid])).toThrow(
      "所选审批模型不可用，请重新选择。",
    );
  }
});
