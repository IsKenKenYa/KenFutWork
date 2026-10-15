import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInstanceImageProvider } from "../../providers/resolve.js";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

const IMAGE_RESPONSE = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
      },
      finishReason: "STOP",
    },
  ],
};

function captureGenerateContent(response: unknown = IMAGE_RESPONSE) {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.json(),
      });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google image BYOK 实例适配器", () => {
  it("用户声明的原生 Gemini 模型经真实 SDK 发往实例网关并返回图片", async () => {
    const requests = captureGenerateContent();
    const provider = resolveInstanceImageProvider("google-image", {
      credentials: {
        apiKey: "google-instance-key",
        baseUrl: "https://gemini-gateway.example",
        headers: { "x-tenant-id": "local-instance" },
      },
      models: [
        { id: "gemini-custom-image-preview", name: "自定义 Gemini 图片" },
      ],
    });

    const image = await provider.generate({
      model: "gemini-custom-image-preview",
      prompt: "将参考图改为蓝色背景",
      aspectRatio: "16:9",
      quality: "ultra",
      inputImages: ["data:image/png;base64,cmVmZXJlbmNl"],
    });

    expect(provider.models).toEqual([
      {
        id: "gemini-custom-image-preview",
        displayName: "自定义 Gemini 图片",
        description: "BYOK instance model",
      },
    ]);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(
      "https://gemini-gateway.example/v1beta/models/gemini-custom-image-preview:generateContent",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("x-tenant-id")).toBe("local-instance");
    expect(request?.headers.get("x-goog-api-key")).toBe("google-instance-key");
    expect(request?.body).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { text: "将参考图改为蓝色背景" },
            { inlineData: { mimeType: "image/png", data: "cmVmZXJlbmNl" } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
      },
    });
    expect(image).toMatchObject({
      url: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
    });
    expect(image.width).toBeGreaterThan(image.height);
  });

  it.each([
    {
      model: "google-official/gemini-2.5-flash-image",
      apiModel: "gemini-2.5-flash-image",
      imageSize: undefined,
    },
    {
      model: "gemini-2.5-flash-image",
      apiModel: "gemini-2.5-flash-image",
      imageSize: undefined,
    },
    {
      model: "google-official/gemini-3.1-flash-image-preview",
      apiModel: "gemini-3.1-flash-image-preview",
      imageSize: "2K",
    },
    {
      model: "google-official/gemini-3-pro-image-preview",
      apiModel: "gemini-3-pro-image-preview",
      imageSize: "2K",
    },
  ])(
    "保留 $model 的协议映射与已知尺寸能力",
    async ({ model, apiModel, imageSize }) => {
      const requests = captureGenerateContent();
      const provider = resolveInstanceImageProvider("google-image", {
        credentials: {
          apiKey: "google-instance-key",
          baseUrl: "https://gemini-gateway.example/",
        },
        models: [{ id: model, name: model }],
      });

      await provider.generate({ model, prompt: "一只猫" });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        `https://gemini-gateway.example/v1beta/models/${apiModel}:generateContent`,
      );
      expect(requests[0]?.body).toMatchObject({
        generationConfig: { imageConfig: { aspectRatio: "1:1" } },
      });
      if (imageSize) {
        expect(requests[0]?.body).toMatchObject({
          generationConfig: { imageConfig: { imageSize } },
        });
      } else {
        expect(requests[0]?.body).not.toMatchObject({
          generationConfig: { imageConfig: { imageSize: expect.anything() } },
        });
      }
    },
  );

  it.each([
    {
      response: { candidates: [{ finishReason: "IMAGE_SAFETY" }] },
      code: "safety_filter",
    },
    {
      response: { promptFeedback: { blockReason: "SAFETY" } },
      code: "safety_filter",
    },
    {
      response: {
        candidates: [{ content: { parts: [{ text: "无法生成" }] } }],
      },
      code: "no_output",
    },
    { response: {}, code: "no_output" },
  ])("供应商未返回图片时明确失败：$code", async ({ response, code }) => {
    const requests = captureGenerateContent(response);
    const provider = resolveInstanceImageProvider("google-image", {
      credentials: { apiKey: "google-instance-key" },
      models: [{ id: "gemini-3-pro-image-preview", name: "Gemini 图片" }],
    });

    await expect(
      provider.generate({
        model: "gemini-3-pro-image-preview",
        prompt: "一只猫",
      }),
    ).rejects.toMatchObject({ provider: "google", code });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    );
  });
});
