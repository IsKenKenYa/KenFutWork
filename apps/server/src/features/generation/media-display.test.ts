import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { generatedMediaDisplay } from "./media-display.js";
import type { SubmitImageJobFn, SubmitVideoJobFn } from "./tool-types.js";
import {
  createImageGenerateToolDefinition,
  runImageGenerate,
} from "./tools/image-generate.js";
import { runVideoGenerate } from "./tools/video-generate.js";

it("成功图片工具投影真实Job/Asset与显式画布落点，quality和placement不丢失", async () => {
  const jobId = randomUUID(),
    assetId = randomUUID(),
    canvasId = randomUUID();
  const submit = vi.fn<SubmitImageJobFn>(async () => ({
    jobId,
    assetId,
    imageUrl: "http://local/real-asset",
    width: 300,
    height: 400,
    mimeType: "image/png",
  }));
  const result = await runImageGenerate(
    {
      title: "海报",
      prompt: "海报内容",
      model: "provider/image",
      canvas_id: canvasId,
      quality: "ultra",
      outputFormat: "webp",
      placementX: 1,
      placementY: 2,
      placementWidth: 3,
      placementHeight: 4,
    },
    undefined,
    submit,
  );
  expect(result).toMatchObject({
    jobId,
    assetId,
    display: {
      kind: "generated_media",
      version: 1,
      jobId,
      assetId,
      mediaType: "image",
      title: "海报",
      width: 300,
      height: 400,
    },
  });
  expect(
    protocol.generatedMediaDisplaySchema.parse(result.display).assetId,
  ).toBe(assetId);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      canvasId,
      quality: "ultra",
      outputFormat: "webp",
      placementX: 1,
      placementY: 2,
      placementWidth: 3,
      placementHeight: 4,
    }),
  );
});

it("成功视频工具投影真实资源，未知尺寸保持未知", async () => {
  const jobId = randomUUID(),
    assetId = randomUUID();
  const submit = vi.fn<SubmitVideoJobFn>(async () => ({
    jobId,
    assetId,
    videoUrl: "http://local/real-video",
    durationSeconds: 5,
    mimeType: "video/mp4",
  }));
  const result = await runVideoGenerate(
    {
      prompt: "视频",
      title: "片段",
      model: "provider/video",
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      enableAudio: false,
    },
    [
      {
        id: "provider/video",
        displayName: "Video",
        description: "Video",
        provider: "test",
        capabilities: {
          textToVideo: true,
          imageToVideo: true,
          videoToVideo: true,
          audio: false,
        },
        limits: { maxDuration: 15, maxResolution: "1080p", maxInputImages: 2 },
      },
    ],
    submit,
  );
  expect(result.display).toEqual({
    kind: "generated_media",
    version: 1,
    jobId,
    assetId,
    mediaType: "video",
    mimeType: "video/mp4",
    title: "片段",
  });
  expect(result.display).not.toHaveProperty("width");
});

it("超时和失败仅保留Job查询身份，不伪造成功媒体投影", async () => {
  const jobId = randomUUID();
  const submit = vi.fn<SubmitImageJobFn>(async () => ({
    jobId,
    error: "timed out",
  }));
  const result = await runImageGenerate(
    { title: "海报", prompt: "海报", model: "provider/image" },
    undefined,
    submit,
  );
  expect(result.jobId).toBe(jobId);
  expect(result.error).toBe("timed out");
  expect(result.display).toBeUndefined();
  expect(result.assetId).toBeUndefined();
});

it.each([
  { source: "Job返回错误", throws: false },
  { source: "提交抛出异常", throws: true },
])(
  "$source时图片工具保留存储失败原因，不建议换模型或简化提示词",
  async ({ throws }) => {
    const jobId = randomUUID();
    const message = "写入超过工作区字节预算";
    const submit = vi.fn<SubmitImageJobFn>(async () => {
      if (throws) throw new Error(message);
      return { jobId, error: message };
    });
    const tool = createImageGenerateToolDefinition({ submitImageJob: submit });

    const result = await tool.execute(
      { title: "海报", prompt: "海报", model: "provider/image" },
      { instanceId: "instance" },
    );

    expect(result).toMatchObject({ error: message });
    expect(result).toHaveProperty("summary", expect.stringContaining(message));
    expect(result).toHaveProperty(
      "summary",
      expect.not.stringMatching(/different model|simplifying the prompt/i),
    );
    if (!throws)
      expect(result).toMatchObject({ jobId, jobType: "image_generation" });
    expect(result).not.toHaveProperty("display");
    expect(result).not.toHaveProperty("assetId");
    expect(submit).toHaveBeenCalledTimes(1);
  },
);

it("缺真实资源UUID时不从URL或文字生成展示身份", () => {
  expect(
    generatedMediaDisplay({ jobId: randomUUID() }, "image"),
  ).toBeUndefined();
  expect(
    generatedMediaDisplay(
      { jobId: "text-job", assetId: randomUUID() },
      "video",
    ),
  ).toBeUndefined();
});
