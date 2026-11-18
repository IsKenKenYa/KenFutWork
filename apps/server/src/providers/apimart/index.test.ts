import { expect, it, vi } from "vitest";
import { resolveInstanceImageProvider } from "../resolve.js";

it("APIMart单次异步提交保留原生多图与全部结果URL，轮询由调用方驱动", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        code: 200,
        data: [{ task_id: "native-task", status: "submitted" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        code: 200,
        data: { id: "native-task", status: "processing" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        code: 200,
        data: {
          id: "native-task",
          status: "completed",
          result: {
            images: [
              {
                url: [
                  "https://assets.example/a.png",
                  "https://assets.example/b.png",
                ],
              },
            ],
          },
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    const provider = resolveInstanceImageProvider("apimart", {
      credentials: {
        apiKey: "test-apimart",
        baseUrl: "https://gateway.example/v1",
      },
      models: [{ id: "gpt-image-1-official", name: "GPT图片" }],
    });
    if (!provider.startAsync || !provider.pollAsync)
      throw new Error("异步驱动未接通");
    await expect(
      provider.startAsync({
        model: "gpt-image-1-official",
        prompt: "纸鹤",
        count: 3,
        aspectRatio: "2:3",
        quality: "high",
        outputFormat: "jpg",
      }),
    ).resolves.toEqual({ providerJobId: "native-task" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://gateway.example/v1/images/generations",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      model: "gpt-image-1-official",
      prompt: "纸鹤",
      n: 3,
      size: "2:3",
      quality: "high",
      output_format: "jpeg",
    });
    await expect(provider.pollAsync("native-task")).resolves.toEqual({
      state: "in_progress",
    });
    await expect(provider.pollAsync("native-task")).resolves.toMatchObject({
      state: "succeeded",
      images: [
        { url: "https://assets.example/a.png" },
        { url: "https://assets.example/b.png" },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(provider.cancelAsync).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("GPT本地参考图在提交前上传为公网链接，保留文件字节且不伪造生成请求", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ url: "https://uploads.example/reference.png" }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: 200, data: [{ task_id: "edited-task" }] }),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    const provider = resolveInstanceImageProvider("apimart", {
      credentials: { apiKey: "test-key" },
      models: [{ id: "gpt-image-1-official", name: "图片" }],
    });
    if (!provider.prepareInputs || !provider.startAsync)
      throw new Error("上传面未接通");
    const prepared = await provider.prepareInputs({
      model: "gpt-image-1-official",
      prompt: "编辑",
      inputImages: ["data:image/png;base64,AQID"],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.apimart.ai/v1/uploads/images",
    );
    const multipart = fetcher.mock.calls[0]?.[1]?.body;
    if (!(multipart instanceof FormData)) throw new Error("上传应为multipart");
    const file = multipart.get("file");
    if (!(file instanceof File)) throw new Error("上传缺少文件");
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("content-type"),
    ).toBe(false);
    await provider.startAsync(prepared);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      image_urls: ["https://uploads.example/reference.png"],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("APIMart视频先上传首尾帧，保留顺序并使用统一任务查询", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ url: "https://uploads.example/first.png" }),
    )
    .mockResolvedValueOnce(
      Response.json({ url: "https://uploads.example/last.png" }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: 200, data: [{ task_id: "video-task" }] }),
    )
    .mockResolvedValueOnce(
      Response.json({
        code: 200,
        data: {
          id: "video-task",
          status: "completed",
          result: { videos: [{ url: ["https://assets.example/video.mp4"] }] },
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    const { resolveInstanceVideoProvider } = await import("../resolve.js");
    const provider = resolveInstanceVideoProvider("apimart", {
      credentials: { apiKey: "video-key" },
      models: [{ id: "veo3.1-fast", name: "Veo" }],
    });
    if (!provider.prepareInputs || !provider.startAsync || !provider.pollAsync)
      throw new Error("异步视频未接通");
    const prepared = await provider.prepareInputs({
      model: "veo3.1-fast",
      prompt: "起飞",
      duration: 8,
      resolution: "1080p",
      aspectRatio: "16:9",
      inputImages: ["data:image/png;base64,AQID", "data:image/png;base64,BAUG"],
    });
    await provider.startAsync(prepared);
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://api.apimart.ai/v1/videos/generations",
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      model: "veo3.1-fast",
      prompt: "起飞",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
      image_urls: [
        "https://uploads.example/first.png",
        "https://uploads.example/last.png",
      ],
    });
    await expect(provider.pollAsync("video-task")).resolves.toEqual({
      state: "succeeded",
      videoUrl: "https://assets.example/video.mp4",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(provider.cancelAsync).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    status: 401,
    body: { error: { message: "invalid private/token" } },
    code: "api_error",
    message: /凭据|Key/,
  },
  {
    status: 429,
    body: { error: { message: "limit private%2Ftoken" } },
    code: "api_error",
    message: /limit/,
  },
  {
    status: 200,
    body: {
      code: 200,
      data: {
        id: "task",
        status: "failed",
        error: { message: "failed private%2Ftoken" },
      },
    },
    code: "provider_task_failed",
    message: /failed/,
  },
  {
    status: 200,
    body: { code: 200, data: { id: "task", status: "cancelled" } },
    code: "provider_task_failed",
    message: /取消/,
  },
  {
    status: 200,
    body: {
      code: 200,
      data: {
        id: "task",
        status: "completed",
        result: { images: [{ url: null }] },
      },
    },
    code: "malformed_response",
    message: /回执/,
  },
])(
  "APIMart错误保留调度字段、脱敏且不在驱动重试：$status/$code",
  async ({ status, body, code, message }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(body, { status, headers: { "retry-after": "7" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = resolveInstanceImageProvider("apimart", {
        credentials: { apiKey: "private/token" },
        models: [],
      });
      if (!provider.pollAsync) throw new Error("查询未接通");
      const error = await provider.pollAsync("task").catch((error) => error);
      expect(error).toMatchObject({
        code,
        message: expect.stringMatching(message),
      });
      expect(error.message).not.toContain("private/token");
      expect(error.message).not.toContain("private%2Ftoken");
      if (status !== 200)
        expect(error).toMatchObject({ status, retryAfter: "7" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
