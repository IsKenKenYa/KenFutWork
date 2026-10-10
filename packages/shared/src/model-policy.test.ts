import { expect, it } from "vitest";
import { instanceSettingsUpdateRequestSchema } from "./http.js";

it("实例模型默认无损承载聊天引用与图像手动候选，视频可独立自动", () => {
  const defaults = {
    chat: {
      providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
      modelId: "聊天：中文/模型",
    },
    image: {
      mode: "manual",
      models: [
        {
          providerId: "2fd9fcda-6273-47c9-a1e4-7f718bf75b5e",
          modelId: "图片:编辑/α",
        },
      ],
    },
    video: { mode: "auto" },
  };
  const result = instanceSettingsUpdateRequestSchema.parse({
    modelDefaults: defaults,
  });
  expect(result).toEqual({ modelDefaults: defaults });
});

it("手动候选拒绝重复模型身份，同名模型可来自不同供应商", () => {
  const first = {
    providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    modelId: "共享模型",
  };
  const request = (models: unknown[]) => ({
    modelDefaults: {
      chat: null,
      image: { mode: "manual", models },
      video: { mode: "auto" },
    },
  });
  expect(
    instanceSettingsUpdateRequestSchema.safeParse(request([first, first]))
      .success,
  ).toBe(false);
  expect(
    instanceSettingsUpdateRequestSchema.parse(
      request([
        first,
        {
          providerId: "2fd9fcda-6273-47c9-a1e4-7f718bf75b5e",
          modelId: "共享模型",
        },
      ]),
    ),
  ).toEqual(
    request([
      first,
      {
        providerId: "2fd9fcda-6273-47c9-a1e4-7f718bf75b5e",
        modelId: "共享模型",
      },
    ]),
  );
});

it("UUID 大小写表示同一供应商，规范化后不能绕过候选去重", () => {
  const reference = {
    providerId: "C0A03EB2-D58C-4637-9FDA-C796230A751A",
    modelId: "图片",
  };
  const defaults = {
    chat: reference,
    image: { mode: "auto" },
    video: { mode: "auto" },
  };
  expect(
    instanceSettingsUpdateRequestSchema.parse({ modelDefaults: defaults }),
  ).toEqual({
    modelDefaults: {
      ...defaults,
      chat: {
        providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
        modelId: "图片",
      },
    },
  });
  expect(
    instanceSettingsUpdateRequestSchema.safeParse({
      modelDefaults: {
        ...defaults,
        image: {
          mode: "manual",
          models: [
            reference,
            { ...reference, providerId: reference.providerId.toLowerCase() },
          ],
        },
      },
    }).success,
  ).toBe(false);
});
