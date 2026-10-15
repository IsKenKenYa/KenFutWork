import { afterEach, expect, it, vi } from "vitest";
import { resolveInstanceVideoProvider } from "../../providers/resolve.js";

afterEach(() => vi.unstubAllGlobals());

it("Seedance提交和查询的SDK错误仅暴露脱敏的安全分类字段", async () => {
  const apiKey = "ark-wire-secret";
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: "cgt-error-boundary" }));
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceVideoProvider("volces", {
    credentials: {
      apiKey,
      baseUrl: "https://ark-gateway.example/api/v3",
    },
    models: [{ id: "ep-custom-video", name: "自定义视频模型" }],
  });
  if (!provider.startAsync || !provider.pollAsync) {
    throw new Error("Seedance异步接口未接线");
  }
  const handle = await provider.startAsync({
    model: "ep-custom-video",
    prompt: "准备查询句柄",
  });
  request.mockClear();

  for (const entry of ["start", "poll"]) {
    for (const failure of [
      { status: 429, code: "RateLimitExceeded", retryAfter: "17" },
      { status: 403, code: "insufficient_quota", retryAfter: undefined },
    ]) {
      request.mockResolvedValueOnce(
        Response.json(
          { error: { code: failure.code, message: `请求被拒绝 ${apiKey}` } },
          {
            status: failure.status,
            headers: failure.retryAfter
              ? { "Retry-After": failure.retryAfter }
              : {},
          },
        ),
      );

      const error = await (entry === "start"
        ? provider.startAsync({ model: "ep-custom-video", prompt: "一只猫" })
        : provider.pollAsync(handle.providerJobId)
      ).catch((value: unknown) => value);

      expect(error).toMatchObject({
        name: "GenerationError",
        provider: "volces",
        code: "api_error",
        status: failure.status,
        retryAfter: failure.retryAfter,
        upstreamCode: failure.code,
        message: expect.not.stringContaining(apiKey),
      });
      expect(error).not.toHaveProperty("requestBodyValues");
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain(apiKey);
      expect(request).toHaveBeenCalledOnce();
      expect(String(request.mock.calls[0]?.[0])).toBe(
        entry === "start"
          ? "https://ark-gateway.example/api/v3/contents/generations/tasks"
          : "https://ark-gateway.example/api/v3/contents/generations/tasks/cgt-error-boundary",
      );
      expect(request.mock.calls[0]?.[1]?.method ?? "GET").toBe(
        entry === "start" ? "POST" : "GET",
      );
      request.mockClear();
    }
  }
});

it("Seedance自定义Endpoint原生分辨率和标准像素值均实际发送", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ id: "cgt-native-resolution" }),
  );
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceVideoProvider("volces", {
    credentials: {
      apiKey: "ark-key",
      baseUrl: "https://ark-gateway.example/api/v3",
    },
    models: [{ id: "ep-custom-video", name: "自定义视频模型" }],
  });
  if (!provider.startAsync) throw new Error("Seedance异步接口未接线");

  // 仅验证自定义网关参数保留，不声明官方 Seedance 模型支持 512p。
  for (const resolution of ["512p", "1024x576"]) {
    await provider.startAsync({
      model: "ep-custom-video",
      prompt: "一只猫",
      resolution,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://ark-gateway.example/api/v3/contents/generations/tasks",
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "ep-custom-video",
      resolution,
    });
    request.mockClear();
  }
});

it.each(["480p", "720p", "1080p"] as const)(
  "Seedance真实SDK传首尾帧/%s/声音，恢复句柄只查询一次",
  async (resolution) => {
    const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify(
            requests.length === 1
              ? { id: "cgt-1" }
              : {
                  id: "cgt-1",
                  status: "succeeded",
                  content: { video_url: "https://cdn.example/v.mp4" },
                },
          ),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const provider = resolveInstanceVideoProvider("volces", {
      credentials: {
        apiKey: "ark-key",
        baseUrl: "https://ark.example/api/v3",
        headers: { "x-tenant": "test" },
      },
      models: [{ id: "seedance-user-model", name: "Seedance" }],
    });
    const images = ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="];
    if (!provider.startAsync || !provider.pollAsync)
      throw new Error("Seedance异步接口未接线");
    const handle = await provider.startAsync({
      model: "seedance-user-model",
      prompt: "transition",
      duration: 6,
      aspectRatio: "16:9",
      resolution,
      enableAudio: true,
      inputImages: images,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://ark.example/api/v3/contents/generations/tasks",
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer ark-key",
    );
    expect(new Headers(requests[0]?.init?.headers).get("x-tenant")).toBe(
      "test",
    );
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body).toMatchObject({
      model: "seedance-user-model",
      resolution,
      duration: 6,
      ratio: "16:9",
      generate_audio: true,
    });
    expect(body.content).toEqual([
      { type: "text", text: "transition" },
      { type: "image_url", image_url: { url: images[0] }, role: "first_frame" },
      { type: "image_url", image_url: { url: images[1] }, role: "last_frame" },
    ]);
    await expect(
      provider.pollAsync(JSON.parse(JSON.stringify(handle)).providerJobId),
    ).resolves.toEqual({
      state: "succeeded",
      videoUrl: "https://cdn.example/v.mp4",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      "https://ark.example/api/v3/contents/generations/tasks/cgt-1",
    );
  },
);

it("不支持的Seedance多图/视频输入显式拒绝，不静默丢弃", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceVideoProvider("volces", {
    credentials: { apiKey: "key" },
    models: [{ id: "model", name: "Seedance" }],
  });
  if (!provider.startAsync) throw new Error("Seedance异步接口未接线");
  for (const input of [
    { inputImages: ["a", "b", "c"] },
    { inputVideo: "https://cdn.example/ref.mp4" },
  ]) {
    await expect(
      provider.startAsync({ model: "model", prompt: "p", ...input }),
    ).rejects.toMatchObject({ code: "unsupported" });
  }
  expect(request).not.toHaveBeenCalled();
});
