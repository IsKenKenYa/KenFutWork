import { describe, expect, it, vi } from "vitest";
import {
  AisdkFactoryError,
  createAisdkGenerationModel,
  createOpenCompatibleProvider,
  createVolcesProvider,
  VOLCES_AISDK_DEFAULT_BASE_URL,
} from "./factory.js";

/** 抓包口径的 canned OpenAI 图像响应（公开稳定形状）。 */
function openaiImageResponse(): Response {
  return new Response(
    JSON.stringify({ created: 1, data: [{ b64_json: "aGVsbG8=" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createOpenCompatibleProvider", () => {
  it("缺 baseUrl fail loud（无可用缺省网关）", () => {
    expect(() => createOpenCompatibleProvider({ apiKey: "sk-test" })).toThrow(
      AisdkFactoryError,
    );
    expect(() =>
      createAisdkGenerationModel("openai-compatible", "image", "m", {
        apiKey: "sk-test",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "aisdk_base_url_required" }),
    );
  });

  it("openai-compatible 只接图像；video 请求 fail loud", () => {
    expect(() =>
      createAisdkGenerationModel("openai-compatible", "video", "m", {
        baseUrl: "https://gw.example/v1",
        apiKey: "k",
      }),
    ).toThrowError(expect.objectContaining({ code: "aisdk_kind_unsupported" }));
  });

  it("凭证与自定义头原样到达线上（抓包口径）：URL、Authorization、自定义头、请求体", async () => {
    const recording = vi.fn(async () => openaiImageResponse());
    const provider = createOpenCompatibleProvider({
      baseUrl: "https://gw.example/v1",
      apiKey: "sk-test",
      headers: { "x-test": "v" },
      fetch: recording as unknown as typeof fetch,
    });
    const result = await provider.imageModel("img-1").doGenerate({
      prompt: "画一只猫",
      n: 1,
      providerOptions: {},
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
    });

    expect(recording).toHaveBeenCalledTimes(1);
    const [url, init] = recording.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://gw.example/v1/images/generations");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("x-test")).toBe("v");
    const body = JSON.parse(init.body) as { prompt: string; n: number };
    expect(body).toMatchObject({ prompt: "画一只猫", n: 1, model: "img-1" });
    // openai-compatible@3.0.51 的 doGenerate 运行时形状是 {images: string[]}（无
    // mime 的 base64 数组），不是 V4 spec 的 files 联合——阶段 B 的 provider 封装
    // 负责映射到 GeneratedImage；此处锁定运行时事实防漂移。
    expect(result).toMatchObject({ images: ["aGVsbG8="] });
    // 凭证红线：请求体不携带原始 key（本测试同时是回归哨兵）
    expect(init.body).not.toContain("sk-test");
  });
});

describe("createVolcesProvider", () => {
  it("缺 baseUrl 用火山方舟 cn-beijing 缺省——不是 bytedance 包的 BytePlus 国际端点", () => {
    expect(VOLCES_AISDK_DEFAULT_BASE_URL).toBe(
      "https://ark.cn-beijing.volces.com/api/v3",
    );
    const provider = createVolcesProvider({ apiKey: "ark-key" });
    expect(typeof provider.imageModel).toBe("function");
    expect(typeof provider.videoModel).toBe("function");
  });

  it("volces 协议可产图像与视频两种模型；凭证含 fetch 注入口", () => {
    const recording = vi.fn(async () => openaiImageResponse());
    const provider = createVolcesProvider({
      baseUrl: "https://ark.example/api/v3",
      apiKey: "k",
      headers: { "x-t": "1" },
      fetch: recording as unknown as typeof fetch,
    });
    expect(provider.imageModel("seedream-4-0-250828")).toBeDefined();
    expect(provider.videoModel("seedance-1-0-pro-250528")).toBeDefined();
  });
});

describe("createAisdkGenerationModel（协议分发）", () => {
  it("未接入协议 fail loud（google 系 / replicate / metaso / chat 三家维持既有实现）", () => {
    for (const protocol of [
      "anthropic",
      "gemini",
      "google-image",
      "replicate",
      "metaso",
    ] as const) {
      expect(() =>
        createAisdkGenerationModel(protocol, "image", "m", {
          baseUrl: "https://x",
          apiKey: "k",
        }),
      ).toThrowError(
        expect.objectContaining({ code: "aisdk_protocol_unsupported" }),
      );
    }
  });
});
