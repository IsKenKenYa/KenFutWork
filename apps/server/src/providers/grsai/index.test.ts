import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  resolveInstanceImageProvider,
  resolveInstanceVideoProvider,
} from "../resolve.js";

it("GRSAI实例只提交一次异步图片请求，完整传参考图并由调用方逐次查询", async () => {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    auth: string | undefined;
    session: string | undefined;
    body: unknown;
  }> = [];
  let queries = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      path: request.url,
      auth: request.headers.authorization,
      session: request.headers["x-session"] as string | undefined,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST")
      response.end(JSON.stringify({ id: "task-image", status: "running" }));
    else
      response.end(
        JSON.stringify(
          ++queries === 1
            ? { id: "task-image", status: "running", progress: 30 }
            : {
                id: "task-image",
                status: "succeeded",
                results: [{ url: "https://assets.example/output.png" }],
              },
        ),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("模拟供应商未启动");
    const provider = resolveInstanceImageProvider("grsai", {
      credentials: {
        apiKey: "instance-test-secret",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: { "X-Session": "session-a" },
      },
      models: [{ id: "nano-banana-2", name: "我的图片" }],
    });
    if (!provider.startAsync || !provider.pollAsync)
      throw new Error("图片异步驱动未接通");
    expect(provider.models[0]?.displayName).toBe("我的图片");
    await expect(
      provider.startAsync({
        model: "nano-banana-2",
        prompt: "纸鹤",
        quality: "2K",
        aspectRatio: "16:9",
        inputImages: [
          "data:image/png;base64,AQIDBA==",
          "https://assets.example/reference.png",
        ],
      }),
    ).resolves.toEqual({ providerJobId: "task-image" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/v1/api/generate",
      auth: "Bearer instance-test-secret",
      session: "session-a",
      body: {
        model: "nano-banana-2",
        prompt: "纸鹤",
        replyType: "async",
        imageSize: "2K",
        aspectRatio: "16:9",
        images: ["AQIDBA==", "https://assets.example/reference.png"],
      },
    });
    await expect(provider.pollAsync("task-image")).resolves.toEqual({
      state: "in_progress",
    });
    await expect(provider.pollAsync("task-image")).resolves.toMatchObject({
      state: "succeeded",
      images: [
        { url: "https://assets.example/output.png", mimeType: "image/png" },
      ],
    });
    expect(requests.map((r) => r.path)).toEqual([
      "/v1/api/generate",
      "/v1/api/result?id=task-image",
      "/v1/api/result?id=task-image",
    ]);
    expect(provider.cancelAsync).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("GRSAI视频驱动映射H3原生参数并使用同一单次任务查询", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ id: "video-task", status: "running" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "video-task",
        status: "succeeded",
        results: [{ url: "https://assets.example/video.mp4" }],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    const provider = resolveInstanceVideoProvider("grsai", {
      credentials: { apiKey: "test-key", baseUrl: "https://grsai.example" },
      models: [{ id: "minimax-h3", name: "我的视频" }],
    });
    if (!provider.startAsync || !provider.pollAsync)
      throw new Error("视频异步驱动未接通");
    await expect(
      provider.startAsync({
        model: "minimax-h3",
        prompt: "纸鹤起飞",
        duration: 5,
        resolution: "768p",
        aspectRatio: "16:9",
        inputImages: [
          "data:image/png;base64,AQID",
          "https://assets.example/ref.png",
        ],
      }),
    ).resolves.toEqual({ providerJobId: "video-task" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      model: "minimax-h3",
      prompt: "纸鹤起飞",
      duration: 5,
      resolution: "768p",
      aspectRatio: "landscape",
      images: ["AQID", "https://assets.example/ref.png"],
      replyType: "async",
    });
    await expect(provider.pollAsync("video-task")).resolves.toEqual({
      state: "succeeded",
      videoUrl: "https://assets.example/video.mp4",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://grsai.example/v1/api/result?id=video-task",
    );
    expect(provider.cancelAsync).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    status: 401,
    body: { id: "failure", status: "failed", error: "invalid test-secret" },
    code: "api_error",
    message: /供应商|GRSAI|凭据/,
  },
  {
    status: 429,
    body: { id: "failure", status: "failed", error: "limit test-secret" },
    code: "api_error",
    message: /limit/,
  },
  {
    status: 200,
    body: { id: "failure", status: "violation", error: "blocked test-secret" },
    code: "safety_filter",
    message: /blocked/,
  },
  {
    status: 200,
    body: { id: "failure", status: "failed", error: "failed test-secret" },
    code: "provider_task_failed",
    message: /failed/,
  },
  {
    status: 200,
    body: { id: "bad", status: "succeeded", results: [null] },
    code: "malformed_response",
    message: /回执|结果/,
  },
])(
  "GRSAI错误翻译保留调度元数据且不重试或泄漏Key：HTTP$status/$code",
  async ({ status, body, code, message }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(body, { status, headers: { "retry-after": "7" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = resolveInstanceImageProvider("grsai", {
        credentials: { apiKey: "test-secret" },
        models: [{ id: "nano-banana-2", name: "图片" }],
      });
      if (!provider.pollAsync) throw new Error("查询未接通");
      const failure = await provider
        .pollAsync("failure")
        .catch((error) => error);
      expect(failure).toMatchObject({
        code,
        message: expect.stringMatching(message),
      });
      expect(failure.message).not.toContain("test-secret");
      if (status !== 200)
        expect(failure).toMatchObject({ status, retryAfter: "7" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
