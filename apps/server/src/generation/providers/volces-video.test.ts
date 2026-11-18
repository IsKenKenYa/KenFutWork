import { describe, expect, it, vi } from "vitest";
import { pollVideoJob, submitVideoJob } from "../aisdk/video-job.js";
import { VolcesVideoProvider } from "./volces-video.js";

/**
 * volces 视频（Seedance，G4 关闭项）：AI SDK 防腐缝边界测试——
 * mock aisdk/video-job，断言参数映射（i2v→首帧、audio、JSON 串任务引用）
 * 与「仅异步任务面」的 fail loud 语义。
 */

vi.mock("../aisdk/video-job.js", () => ({
  submitVideoJob: vi.fn(),
  pollVideoJob: vi.fn(),
}));
vi.mock("../aisdk/factory.js", () => ({
  createVolcesProvider: vi.fn(() => ({
    videoModel: vi.fn(() => ({ modelStub: true })),
  })),
}));

const provider = new VolcesVideoProvider(
  "ark-key",
  "https://ark.example/api/v3",
);

describe("VolcesVideoProvider", () => {
  it("startAsync：参数映射到 submitVideoJob，任务引用 JSON 串化", async () => {
    vi.mocked(submitVideoJob).mockResolvedValue({
      operation: { id: "cgt-1" },
      warnings: [],
    });
    const { providerJobId } = await provider.startAsync({
      prompt: "一只猫在跑",
      model: "seedance-1-0-pro-250528",
      duration: 5,
      aspectRatio: "16:9",
      inputImages: ["https://img.example/first.png"],
    });
    expect(providerJobId).toBe(JSON.stringify({ id: "cgt-1" }));
    expect(vi.mocked(submitVideoJob).mock.calls[0]?.[1]).toMatchObject({
      prompt: "一只猫在跑",
      duration: 5,
      aspectRatio: "16:9",
      frameImages: [
        {
          image: "https://img.example/first.png",
          frameType: "first_frame",
        },
      ],
    });
  });

  it("pollAsync：url 产物归一为 succeeded；未终态归一为 in_progress", async () => {
    vi.mocked(pollVideoJob).mockResolvedValue({
      state: "succeeded",
      videos: [
        {
          type: "url",
          url: "https://cdn.example/v.mp4",
          mediaType: "video/mp4",
        },
      ],
      warnings: [],
    });
    await expect(
      provider.pollAsync(JSON.stringify({ id: "cgt-1" })),
    ).resolves.toEqual({
      state: "succeeded",
      videoUrl: "https://cdn.example/v.mp4",
    });

    vi.mocked(pollVideoJob).mockResolvedValue({ state: "in_progress" });
    await expect(provider.pollAsync('{"id":"cgt-1"}')).resolves.toEqual({
      state: "in_progress",
    });
  });

  it("非 JSON 任务引用 → malformatted fail loud（引擎按不可重试处理）", async () => {
    await expect(provider.pollAsync("not-json")).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("generate 显式不支持（仅异步任务面）", async () => {
    await expect(
      provider.generate({ prompt: "p", model: "seedance-1-0-pro-250528" }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
