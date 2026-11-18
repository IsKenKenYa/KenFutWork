import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METASO_DEFAULT_BASE_URL,
  METASO_VIDEO_MODEL_ID,
} from "../../generation/providers/metaso-video.js";
import type {
  VideoGenerateParams,
  VideoProvider,
} from "../../generation/types.js";
import { resolveInstanceVideoProvider } from "../resolve.js";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function provider(
  model = METASO_VIDEO_MODEL_ID,
  baseUrl = METASO_DEFAULT_BASE_URL,
): VideoProvider {
  return resolveInstanceVideoProvider("metaso", {
    credentials: {
      apiKey: "instance-secret",
      baseUrl,
      headers: { "X-Session": "trusted-session" },
    },
    models: [{ id: model, name: "我的 H3" }],
  });
}

function submit(provider: VideoProvider, params: VideoGenerateParams) {
  if (!provider.startAsync) throw new Error("实例适配器缺少异步提交能力");
  return provider.startAsync(params);
}

function poll(provider: VideoProvider, providerJobId: string) {
  if (!provider.pollAsync) throw new Error("实例适配器缺少单次查询能力");
  return provider.pollAsync(providerJobId);
}

function firstRequest() {
  const request = fetchMock.mock.calls[0];
  if (!request) throw new Error("未发送供应商请求");
  return {
    url: String(request[0]),
    init: request[1],
    body: JSON.parse(String(request[1]?.body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Metaso 实例适配器的真实请求边界", () => {
  it("实例模型保留用户命名并声明 H3 的首尾帧与 4–15 秒能力", () => {
    expect(provider().models).toEqual([
      expect.objectContaining({
        id: METASO_VIDEO_MODEL_ID,
        displayName: "我的 H3",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: false,
          audio: false,
        },
        limits: {
          maxDuration: 15,
          allowedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          maxResolution: "1080p",
          maxInputImages: 2,
        },
      }),
    ]);
  });

  it("异步提交只发送一次 POST 并返回可持久化句柄，不自动查询", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }));
    await expect(
      submit(provider(), {
        model: METASO_VIDEO_MODEL_ID,
        prompt: "纸鹤起飞",
      }),
    ).resolves.toEqual({ providerJobId: "task-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstRequest()).toMatchObject({
      url: `${METASO_DEFAULT_BASE_URL}v2/video_generation`,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer instance-secret",
          "X-Session": "trusted-session",
          "Content-Type": "application/json",
        },
      },
      body: {
        model: "MiniMax-H3",
        content: [{ type: "text", text: "纸鹤起飞" }],
        resolution: "768P",
        duration: 5,
        ratio: "16:9",
      },
    });
  });

  it("首尾帧、15 秒和 1080p 穿透实例工厂映射到 H3 请求", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ task_id: "task-frames" }));
    await submit(provider(), {
      model: METASO_VIDEO_MODEL_ID,
      prompt: "首尾画面转场",
      duration: 15,
      resolution: "1080p",
      aspectRatio: "9:16",
      inputImages: [
        "https://assets.example/first.png",
        "data:image/png;base64,AAAA",
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstRequest().body).toEqual({
      model: "MiniMax-H3",
      content: [
        { type: "text", text: "首尾画面转场" },
        {
          type: "image_url",
          image_url: { url: "https://assets.example/first.png" },
          role: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
          role: "last_frame",
        },
      ],
      resolution: "2K",
      duration: 15,
      ratio: "adaptive",
    });
  });

  it("原生 MiniMax-H3 模型 ID 经实例工厂提交，与现有别名使用同一协议", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ task_id: "native-h3" }));
    await expect(
      submit(provider("MiniMax-H3", "https://api.minimax.io"), {
        model: "MiniMax-H3",
        prompt: "原生 H3 请求",
        duration: 4,
        resolution: "720p",
      }),
    ).resolves.toEqual({ providerJobId: "native-h3" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstRequest().url).toBe(
      "https://api.minimax.io/v2/video_generation",
    );
    expect(firstRequest().body).toMatchObject({
      model: "MiniMax-H3",
      duration: 4,
      resolution: "768P",
    });
  });

  it("序列化保存句柄后以新实例续查原任务，不再提交", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ task_id: "task/恢复 1" }));
    const handle = await submit(provider(), {
      model: METASO_VIDEO_MODEL_ID,
      prompt: "继续原任务",
    });
    const restored = JSON.parse(JSON.stringify(handle));
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: {
          status: "succeeded",
          modality: "video",
          content: { url: "https://assets.example/recovered.mp4" },
        },
      }),
    );
    await expect(poll(provider(), restored.providerJobId)).resolves.toEqual({
      state: "succeeded",
      videoUrl: "https://assets.example/recovered.mp4",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe(
      `${METASO_DEFAULT_BASE_URL}v2/query/video_generation/${encodeURIComponent("task/恢复 1")}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    { status: "queued", expected: { state: "in_progress" } },
    { status: "running", expected: { state: "in_progress" } },
    {
      status: "succeeded",
      expected: {
        state: "succeeded",
        videoUrl: "https://assets.example/result.mp4",
      },
    },
    {
      status: "failed",
      expected: { state: "failed", errorMessage: "blocked: key=[redacted]" },
    },
    {
      status: "cancelled",
      expected: {
        state: "failed",
        errorMessage: "Metaso video generation was cancelled",
      },
    },
  ])(
    "每次 $status 查询只发一次 GET 并返回归一状态",
    async ({ status, expected }) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          task: {
            status,
            content: { url: "https://assets.example/result.mp4" },
            error: { code: "blocked", message: "key=instance-secret" },
          },
        }),
      );
      await expect(poll(provider(), "task-state")).resolves.toEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    },
  );

  it.each<{ overrides: Partial<VideoGenerateParams>; message: string }>([
    { overrides: { duration: 3 }, message: "duration" },
    { overrides: { duration: 16 }, message: "duration" },
    { overrides: { resolution: "480p" }, message: "resolution" },
    {
      overrides: { inputImages: ["one", "two", "three"] },
      message: "at most two",
    },
    { overrides: { enableAudio: true }, message: "audio generation" },
  ])("无效 H3 输入 $overrides 在联网前拒绝", async ({ overrides, message }) => {
    await expect(
      submit(provider(), {
        model: METASO_VIDEO_MODEL_ID,
        prompt: "拒绝无效输入",
        ...overrides,
      }),
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未知厂商状态不伪装为进行中，也不自动重查", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { status: "unexpected-state" } }),
    );
    await expect(poll(provider(), "task-unknown")).rejects.toMatchObject({
      code: "malformed_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
