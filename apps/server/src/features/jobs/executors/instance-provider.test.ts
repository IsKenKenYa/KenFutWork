import { describe, expect, it, vi } from "vitest";

import {
  resolveInstanceImageProviderFromPayload,
  resolveInstanceVideoProviderFromPayload,
} from "./instance-provider.js";

/**
 * capability 过滤（阶段 B 契约扩展回归）：`image-edit` 模型必须能被图像
 * 适配器选中（与 `image` 同一执行面），video 过滤不受影响。
 */

function ctxWith(models: Array<{ id: string; capability: string }>) {
  return {
    modelProviders: {
      resolveCredentialsById: vi.fn(async () => ({
        protocol: "openai-compatible",
        apiKey: "sk-test",
        baseUrl: "https://gw.example/v1",
        headers: undefined,
        models,
      })),
    },
  };
}

describe("resolveInstance*ProviderFromPayload（capability 过滤）", () => {
  it("image-edit 模型进入图像适配器模型面（与 image 同一执行面）", async () => {
    const provider = await resolveInstanceImageProviderFromPayload(
      "11111111-1111-1111-1111-111111111111",
      ctxWith([
        { id: "img-1", capability: "image" },
        { id: "edit-1", capability: "image-edit" },
        { id: "vid-1", capability: "video" },
      ]) as never,
    );
    expect(provider).toBeDefined();
    expect(provider?.models.map((m) => m.id).sort()).toEqual([
      "edit-1",
      "img-1",
    ]);
  });

  it("video 过滤不含 image / image-edit（replicate 协议有视频适配器）", async () => {
    const ctx = {
      modelProviders: {
        resolveCredentialsById: vi.fn(async () => ({
          protocol: "replicate",
          apiKey: "r8-key",
          baseUrl: "https://api.replicate.com",
          headers: undefined,
          configRevision: 1,
          models: [
            { id: "img-1", capability: "image" },
            { id: "edit-1", capability: "image-edit" },
            { id: "vid-1", capability: "video" },
          ],
        })),
      },
    };
    const result = await resolveInstanceVideoProviderFromPayload(
      "11111111-1111-1111-1111-111111111111",
      ctx as never,
    );
    expect(result).toBeDefined();
    expect(result?.configRevision).toBe(1);
    expect(result?.provider.models.map((m) => m.id)).toEqual(["vid-1"]);
  });

  it("无供应商引用不尝试解析凭据", async () => {
    expect(
      await resolveInstanceImageProviderFromPayload(undefined, {}),
    ).toBeUndefined();
    expect(
      await resolveInstanceVideoProviderFromPayload(undefined, {}),
    ).toBeUndefined();
  });
});
