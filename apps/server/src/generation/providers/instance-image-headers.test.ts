import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { METASO_VIDEO_MODEL_ID, MetasoVideoProvider } from "./metaso-video.js";
import { ReplicateImageProvider } from "./replicate-image.js";
import { ReplicateVideoProvider } from "./replicate-video.js";
import { VolcesImageProvider } from "./volces-image.js";

/**
 * 图/视频适配器的自定义请求头上线（§4.8「一视同仁」，避免「聊天能用、生图不能」）。
 *
 * 手法：stub 掉全局 fetch 截获请求头（replicate 的 API 基址是硬编码常量、不可注入），
 * 只断言「头有没有真的发出去 + 凭证头没被顶掉」，不关心各家的响应语义。
 */

type CapturedRequest = { url: string; headers: Record<string, string> };

const CUSTOM_HEADERS = { "x-tenant-id": "ws-42" };

/** 头可能是普通对象、数组或 `Headers` 实例（@google/genai 用后者），统一归一化。 */
function normalizeHeaders(headers: RequestInit["headers"]) {
  return Object.fromEntries(
    Object.entries(
      Object.fromEntries(new Headers(headers ?? {}).entries()),
    ).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function captureFetch(
  respond: (request: CapturedRequest, index: number) => unknown,
) {
  const requests: CapturedRequest[] = [];
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      headers: normalizeHeaders(init?.headers),
    };
    requests.push(request);
    return new Response(JSON.stringify(respond(request, requests.length - 1)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("volces 图/视频适配器自定义头", () => {
  it("自定义头随请求发出，Authorization 仍来自 apiKey", async () => {
    const requests = captureFetch(() => ({
      data: [{ url: "https://cdn.example/img.png" }],
    }));
    const provider = new VolcesImageProvider(
      "volces-key",
      "https://ark.example/api/v3",
      CUSTOM_HEADERS,
    );

    await provider.generate({
      model: "doubao-seedream",
      prompt: "一只猫",
      aspectRatio: "1:1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-tenant-id"]).toBe("ws-42");
    expect(requests[0]?.headers.authorization).toBe("Bearer volces-key");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("未配置自定义头：请求不带多余头", async () => {
    const requests = captureFetch(() => ({
      data: [{ url: "https://cdn.example/img.png" }],
    }));
    await new VolcesImageProvider(
      "volces-key",
      "https://ark.example/api/v3",
    ).generate({ model: "doubao-seedream", prompt: "一只猫" });

    expect(requests[0]?.headers["x-tenant-id"]).toBeUndefined();
    expect(requests[0]?.headers.authorization).toBe("Bearer volces-key");
  });
});

describe("replicate 图/视频适配器自定义头", () => {
  it("图像：自定义头发到 predictions 请求", async () => {
    const requests = captureFetch(() => ({
      output: ["https://cdn.example/img.png"],
      status: "succeeded",
    }));

    await new ReplicateImageProvider("r8-token", CUSTOM_HEADERS).generate({
      model: "black-forest-labs/flux-kontext-pro",
      prompt: "猫",
    });

    expect(requests[0]?.headers["x-tenant-id"]).toBe("ws-42");
    expect(requests[0]?.headers.authorization).toBe("Bearer r8-token");
  });

  it("视频：自定义头同时进创建请求与轮询请求", async () => {
    const requests = captureFetch((_request, index) =>
      index === 0
        ? {
            id: "pred-1",
            output: null,
            status: "processing",
            urls: { get: "https://api.replicate.com/v1/predictions/pred-1" },
          }
        : { output: ["https://cdn.example/v.mp4"], status: "succeeded" },
    );

    // 轮询间隔固定 5s：用假时钟推进，避免测试真的等一轮
    vi.useFakeTimers();
    const provider = new ReplicateVideoProvider("r8-token", CUSTOM_HEADERS);
    const pending = provider.generate({
      model: "wan-video/wan-2.6",
      prompt: "猫",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    vi.useRealTimers();

    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.headers["x-tenant-id"]).toBe("ws-42");
      expect(request.headers.authorization).toBe("Bearer r8-token");
    }
  });
});

describe("metaso 视频适配器自定义头", () => {
  it("自定义头随创建与轮询请求发出，Authorization 仍来自 apiKey", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        ),
      });
      const body =
        calls.length === 1
          ? { task_id: "task-1" }
          : {
              task: {
                id: "task-1",
                status: "succeeded",
                content: { url: "https://cdn.example/v.mp4" },
              },
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new MetasoVideoProvider("metaso-key", undefined, {
      fetch: fetchMock as unknown as typeof fetch,
      headers: CUSTOM_HEADERS,
      sleep: async () => {},
    });
    await provider.generate({ model: METASO_VIDEO_MODEL_ID, prompt: "一只猫" });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.headers["x-tenant-id"]).toBe("ws-42");
      expect(call.headers.authorization).toBe("Bearer metaso-key");
    }
  });
});

describe("google-image 适配器自定义头", () => {
  it("自定义头随 generateContent 请求发出，凭证头 x-goog-api-key 仍由 SDK 生成", async () => {
    const requests = captureFetch(() => ({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: Buffer.from("img").toString("base64"),
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    }));

    const { GoogleImageProvider } = await import("./google-image.js");
    const provider = new GoogleImageProvider("goog-key", CUSTOM_HEADERS);
    await provider.generate({
      model: provider.models[0]?.id ?? "gemini-2.5-flash-image",
      prompt: "一只猫",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-tenant-id"]).toBe("ws-42");
    expect(requests[0]?.headers["x-goog-api-key"]).toBe("goog-key");
  });
});

describe("openai-compatible 图像适配器自定义头", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
  });

  it("自定义头经 OpenAI 客户端发到线上，Authorization 仍来自 apiKey", async () => {
    const requests: Array<Record<string, string | string[] | undefined>> = [];
    server = createServer((req, res) => {
      requests.push({ ...req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: "https://cdn.example/i.png" }] }));
    });
    const stub = server;
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = stub.address() as AddressInfo;

    const { OpenAIImageProvider } = await import("./openai-image.js");
    const provider = new OpenAIImageProvider(
      "sk-image",
      `http://127.0.0.1:${port}/v1`,
      CUSTOM_HEADERS,
    );

    await provider.generate({ model: "gpt-image-1", prompt: "一只猫" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.["x-tenant-id"]).toBe("ws-42");
    expect(requests[0]?.authorization).toBe("Bearer sk-image");
  });
});
