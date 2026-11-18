import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AvailableVideoModel } from "../../generation/types.js";
import { mediaReferenceInput } from "./media-reference-input.js";
import {
  createImageGenerateToolDefinition,
  runImageGenerate,
} from "./tools/image-generate.js";
import {
  createVideoGenerateToolDefinition,
  runVideoGenerate,
} from "./tools/video-generate.js";

const model: AvailableVideoModel = {
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
};
const videoInput = {
  title: "片段",
  prompt: "片段内容",
  model: model.id,
  duration: 5,
  resolution: "720p" as const,
  aspectRatio: "16:9" as const,
  enableAudio: false,
};

it("任何无法解析的引用都保留错误，不丢弃后提交无参考任务", async () => {
  const submit = vi.fn(async () => ({ jobId: randomUUID() }));
  await expect(
    runImageGenerate(
      {
        title: "图",
        prompt: "图",
        model: "provider/image",
        inputImages: ["https://example.test/real.png", "element-id"],
      },
      undefined,
      submit,
    ),
  ).rejects.toThrow("参考素材无法读取");
  await expect(
    runVideoGenerate(
      { ...videoInput, inputImages: ["missing-asset"] },
      [model],
      submit,
    ),
  ).rejects.toThrow("参考素材无法读取");
  await expect(
    runVideoGenerate(
      { ...videoInput, inputVideo: "missing-asset" },
      [model],
      submit,
    ),
  ).rejects.toThrow("参考素材无法读取");
  expect(submit).not.toHaveBeenCalled();
});

it("已接纳的附件映射保留引用顺序，本机URL和错类型data URI拒绝", () => {
  const data = "data:image/png;base64,iVBORw0KGgo=";
  expect(
    mediaReferenceInput(
      ["accepted", "https://example.test/remote.png", "accepted"],
      "image",
      { accepted: data },
    ),
  ).toEqual([data, "https://example.test/remote.png", data]);
  expect(() =>
    mediaReferenceInput(["http://localhost:3001/file"], "image"),
  ).toThrow("参考素材无法读取");
  expect(() => mediaReferenceInput([data], "video")).toThrow(
    "参考素材无法读取",
  );
});

it("图片工具使用插件引用解析器，解析失败不提交Job", async () => {
  const id = randomUUID(),
    data = "data:image/png;base64,iVBORw0KGgo=";
  const resolver = vi.fn(async () => [data]);
  const submit = vi.fn(async () => ({ jobId: randomUUID() }));
  const tool = createImageGenerateToolDefinition({
    resolveMediaReferences: resolver,
    submitImageJob: submit,
  });
  const context = { instanceId: "instance" };
  await tool.execute(
    {
      title: "海报",
      prompt: "海报内容",
      model: "provider/image",
      inputImages: [id],
    },
    context,
  );
  expect(resolver).toHaveBeenCalledWith(context, [
    { reference: id, mediaType: "image" },
  ]);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ inputImages: [data] }),
  );
  resolver.mockRejectedValueOnce(new Error("选区素材已变化"));
  await expect(
    tool.execute(
      {
        title: "海报",
        prompt: "海报内容",
        model: "provider/image",
        inputImages: [id],
      },
      context,
    ),
  ).rejects.toThrow("已变化");
  expect(submit).toHaveBeenCalledTimes(1);
  expect(context).not.toHaveProperty("userAttachmentMap");
});

it("视频图像和输入视频一次解析，共用总量预算且顺序不混淆", async () => {
  const imageId = randomUUID(),
    videoId = randomUUID();
  const image = "data:image/png;base64,iVBORw0KGgo=",
    video = "data:video/mp4;base64,MDAwMGZ0eXBpc29t";
  const resolver = vi.fn(async () => [image, video]);
  const submit = vi.fn(async () => ({ jobId: randomUUID() }));
  const tool = createVideoGenerateToolDefinition({
    availableModels: [model],
    resolveMediaReferences: resolver,
    submitVideoJob: submit,
  });
  const context = { instanceId: "instance" };
  await tool.execute(
    { ...videoInput, inputImages: [imageId], inputVideo: videoId },
    context,
  );
  expect(resolver).toHaveBeenCalledWith(context, [
    { reference: imageId, mediaType: "image" },
    { reference: videoId, mediaType: "video" },
  ]);
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ inputImages: [image], inputVideo: video }),
  );
});
