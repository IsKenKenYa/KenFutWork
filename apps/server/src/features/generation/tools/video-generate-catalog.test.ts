import type { VideoGenerationCaps } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { AvailableVideoModel } from "../../../generation/types.js";
import {
  createVideoGenerateToolDefinition,
  type SubmitVideoJobFn,
} from "./video-generate.js";

// Public tool factory only; the submit seam records arguments and performs no I/O.
type DeclaredModel = AvailableVideoModel & {
  videoGeneration?: VideoGenerationCaps;
};
const h3: DeclaredModel = {
  id: "11111111-1111-4111-8111-111111111111:minimax-h3",
  displayName: "H3",
  description: "Configured H3",
  provider: "Local video",
  capabilities: { imageToVideo: true, audio: false },
  limits: {},
  videoGeneration: {
    durations: [1, 5, 10],
    resolutions: ["480p", "768p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    referenceImages: 9,
    audio: false,
  },
};
const strict: DeclaredModel = {
  id: "11111111-1111-4111-8111-111111111111:strict-video",
  displayName: "Strict",
  description: "Configured strict video",
  provider: "Local video",
  capabilities: { imageToVideo: true, audio: false },
  limits: {},
  videoGeneration: {
    durations: [4, 8],
    resolutions: ["720p"],
    aspectRatios: ["1:1"],
    referenceImages: 2,
    audio: false,
  },
};
const unknown: DeclaredModel = {
  id: "11111111-1111-4111-8111-111111111111:unknown-video",
  displayName: "Unknown",
  description: "No capability metadata",
  provider: "Local video",
  capabilities: {},
  limits: {},
};
const refs = Array.from(
  { length: 9 },
  (_, index) => `https://example.invalid/reference-${index}.png`,
);
const base = {
  title: "纸鹤起飞",
  prompt: "A paper crane takes flight",
  model: h3.id,
  duration: 5,
  resolution: "480p",
  aspectRatio: "16:9",
};
function fixture(models: DeclaredModel[] = [h3, strict, unknown]) {
  const submit = vi
    .fn<SubmitVideoJobFn>()
    .mockResolvedValue({ jobId: "local-test-job" });
  const tool = createVideoGenerateToolDefinition({
    availableModels: models,
    submitVideoJob: submit,
  });
  return {
    tool,
    submit,
    execute: (input: Record<string, unknown>) =>
      tool.execute(input, {} as never),
  };
}
async function rejection(action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe("视频工具按实际选定模型声明参数", () => {
  it("公开模型描述展示实际声明的时长、分辨率、画幅、参考图与音频", () => {
    const f = fixture([h3]);
    for (const description of [
      /(?:durations?|时长)[\s\S]*?\b1\b[\s\S]*?\b5\b[\s\S]*?\b10\b/iu,
      /480p[\s\S]*?768p[\s\S]*?1080p/u,
      /16:9[\s\S]*?9:16/u,
      /(?:referenceImages|参考图(?:片)?)\D*9/iu,
      /(?:audio|音频)[\s\S]*?(?:false|不支持|禁用)/iu,
    ])
      expect(f.tool.parameters).toMatchObject({
        properties: {
          model: { description: expect.stringMatching(description) },
        },
      });
  });

  it.each([
    { duration: 1 },
    { resolution: "768p" },
    { inputImages: refs },
    { duration: 1, resolution: "768p", inputImages: refs },
  ])("公开工具接纳声明支持的1秒、768p与9张参考：%j", async (parameters) => {
    const f = fixture();
    expect(await f.execute({ ...base, ...parameters })).toMatchObject({
      jobId: "local-test-job",
    });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]?.[0]).toMatchObject({
      ...parameters,
      model: h3.id,
    });
  });

  it.each([
    { duration: 5, resolution: "720p", aspectRatio: "1:1" },
    { duration: 4, resolution: "768p", aspectRatio: "1:1" },
    { duration: 4, resolution: "720p", aspectRatio: "16:9" },
    {
      duration: 4,
      resolution: "720p",
      aspectRatio: "1:1",
      inputImages: refs.slice(0, 3),
    },
  ])("另一个模型支持的参数不能跨模型放行：%j", async (parameters) => {
    const f = fixture();
    const result = await rejection(() =>
      f.execute({ ...base, ...parameters, model: strict.id }),
    );
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([h3, strict])(
    "省略参数时仅从该模型声明选择合法默认值：$displayName",
    async (selected) => {
      const f = fixture();
      expect(
        await f.execute({
          title: base.title,
          prompt: base.prompt,
          model: selected.id,
        }),
      ).toMatchObject({ jobId: "local-test-job" });
      expect(f.submit.mock.calls[0]?.[0]).toMatchObject({
        duration: selected.videoGeneration?.durations?.[0],
        resolution: selected.videoGeneration?.resolutions?.[0],
        aspectRatio: selected.videoGeneration?.aspectRatios?.[0],
      });
      expect(f.submit.mock.calls[0]?.[0]).not.toHaveProperty("enableAudio");
    },
  );

  it("无元数据时不制造时长、分辨率、比例或音频默认参数", async () => {
    const f = fixture([unknown]);
    expect(
      await f.execute({
        title: base.title,
        prompt: base.prompt,
        model: unknown.id,
      }),
    ).toMatchObject({ jobId: "local-test-job" });
    expect(f.submit).toHaveBeenCalledOnce();
    for (const field of [
      "duration",
      "resolution",
      "aspectRatio",
      "enableAudio",
    ])
      expect(f.submit.mock.calls[0]?.[0]).not.toHaveProperty(field);
  });

  it("不支持音频开关的模型省略显式false，但拒绝显式true且不提交", async () => {
    const f = fixture();
    expect(await f.execute({ ...base, enableAudio: false })).toMatchObject({
      jobId: "local-test-job",
    });
    expect(f.submit.mock.calls[0]?.[0]).not.toHaveProperty("enableAudio");
    f.submit.mockClear();
    expect(
      await rejection(() => f.execute({ ...base, enableAudio: true })),
    ).toMatchObject({ error: expect.any(String) });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("明确支持音频开关的模型保留显式false，不擅自开启音频", async () => {
    const audio: DeclaredModel = {
      ...h3,
      id: "11111111-1111-4111-8111-111111111111:audio-video",
      capabilities: { ...h3.capabilities, audio: true },
      videoGeneration: { ...h3.videoGeneration, audio: true },
    };
    const f = fixture([audio]);
    expect(
      await f.execute({ ...base, model: audio.id, enableAudio: false }),
    ).toMatchObject({ jobId: "local-test-job" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ enableAudio: false });
  });
});
