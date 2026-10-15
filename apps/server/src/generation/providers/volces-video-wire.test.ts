import { afterEach, expect, it, vi } from "vitest";
import { resolveInstanceVideoProvider } from "../../providers/resolve.js";

afterEach(() => vi.unstubAllGlobals());

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
