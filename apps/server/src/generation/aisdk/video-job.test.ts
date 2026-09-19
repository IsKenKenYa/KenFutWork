import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  assertOperationSerializable,
  createVideoJobDriver,
  pollVideoJob,
  submitVideoJob,
  VideoJobError,
} from "./video-job.js";

/**
 * stub 模型（spec v4 形状）：在 ACL ↔ SDK 的边界上做契约断言——
 * ACL 必须把参数原样透传给 spec API、不传 webhookUrl、结果三态归一。
 */
function stubModel(
  overrides: Record<string, unknown> = {},
): Experimental_VideoModelV4 {
  return {
    specificationVersion: "v4",
    provider: "stub",
    modelId: "stub-video",
    maxVideosPerCall: 1,
    doGenerate: vi.fn(),
    doStart: vi.fn(),
    doStatus: vi.fn(),
    ...overrides,
  } as unknown as Experimental_VideoModelV4;
}

describe("submitVideoJob", () => {
  it("参数原样透传 spec API（含帧图/请求头/中止信号），不传 webhookUrl，operation 透出", async () => {
    const model = stubModel({
      doStart: vi.fn().mockResolvedValue({
        operation: { id: "task-1" },
        warnings: [{ type: "other", message: "不支持 fps" }],
        response: { timestamp: new Date(), modelId: "stub-video", headers: {} },
      }),
    });
    const abortSignal = AbortSignal.abort();
    const handle = await submitVideoJob(model, {
      prompt: "一只猫",
      n: 1,
      aspectRatio: "16:9",
      duration: 5,
      frameImages: [
        { image: "https://example.com/first.png", frameType: "first_frame" },
      ],
      headers: { "x-job": "1" },
      abortSignal,
    });
    expect(handle.operation).toEqual({ id: "task-1" });
    expect(handle.warnings).toEqual(["不支持 fps"]);
    const call = (model.doStart as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    // SDK 会把 URL 字符串归一成文件数据对象（{type:"url", url}）——归一后形状锁定
    expect(call).toMatchObject({
      prompt: "一只猫",
      n: 1,
      aspectRatio: "16:9",
      duration: 5,
      frameImages: [
        {
          image: { type: "url", url: "https://example.com/first.png" },
          frameType: "first_frame",
        },
      ],
      headers: { "x-job": "1" },
      abortSignal,
    });
    // SDK 会显式透传 webhookUrl 键——语义红线是「值为 undefined」（不注册
    // webhook，纯 poll 路径），不是键不存在
    expect(call).toHaveProperty("webhookUrl", undefined);
  });

  it("未实现 doStart 的模型 fail loud（video_async_unsupported），不触达 SDK", async () => {
    const model = stubModel({ doStart: undefined });
    await expect(submitVideoJob(model, { prompt: "p" })).rejects.toMatchObject({
      code: "video_async_unsupported",
    });
  });

  it("operation 不可 JSON 序列化（含 BigInt）→ video_operation_unserializable", async () => {
    const model = stubModel({
      doStart: vi.fn().mockResolvedValue({
        operation: { id: 1n },
        warnings: [],
        response: { timestamp: new Date(), modelId: "x", headers: {} },
      }),
    });
    await expect(submitVideoJob(model, { prompt: "p" })).rejects.toMatchObject({
      code: "video_operation_unserializable",
    });
  });
});

describe("assertOperationSerializable", () => {
  it("合法对象与 null 通过；顶层函数抛 video_operation_unserializable", () => {
    expect(() => assertOperationSerializable({ id: "t" })).not.toThrow();
    expect(() => assertOperationSerializable(null)).not.toThrow();
    expect(() => assertOperationSerializable(() => {})).toThrow(VideoJobError);
  });
});

describe("pollVideoJob（三态归一）", () => {
  it("pending → in_progress，并透传中止信号与请求头", async () => {
    const doStatus = vi.fn().mockResolvedValue({
      status: "pending",
      response: { timestamp: new Date(), modelId: "x", headers: {} },
    });
    const model = stubModel({ doStatus });
    const abortSignal = AbortSignal.abort();
    const result = await pollVideoJob(
      model,
      { id: "t" },
      {
        headers: { "x-poll": "1" },
        abortSignal,
        maxRetries: 0,
      },
    );
    expect(result).toEqual({ state: "in_progress" });
    expect(doStatus.mock.calls[0]?.[0]).toMatchObject({
      operation: { id: "t" },
      headers: { "x-poll": "1" },
      abortSignal,
    });
  });

  it("completed → succeeded，url/base64/binary 三种产物形状保留", async () => {
    const model = stubModel({
      doStatus: vi.fn().mockResolvedValue({
        status: "completed",
        videos: [
          {
            type: "url",
            url: "https://cdn.example/v.mp4",
            mediaType: "video/mp4",
          },
          { type: "base64", data: "AAAA", mediaType: "video/webm" },
          { type: "binary", data: new Uint8Array([1]), mediaType: "video/mp4" },
        ],
        warnings: [{ type: "other" }],
        response: { timestamp: new Date(), modelId: "x", headers: {} },
      }),
    });
    const result = await pollVideoJob(model, { id: "t" });
    expect(result).toEqual({
      state: "succeeded",
      videos: [
        {
          type: "url",
          url: "https://cdn.example/v.mp4",
          mediaType: "video/mp4",
        },
        { type: "base64", data: "AAAA", mediaType: "video/webm" },
        { type: "binary", data: new Uint8Array([1]), mediaType: "video/mp4" },
      ],
      warnings: ["other"],
    });
  });

  it("error → failed + 厂商可读错误文案", async () => {
    const model = stubModel({
      doStatus: vi.fn().mockResolvedValue({
        status: "error",
        error: "内容审核未通过",
        response: { timestamp: new Date(), modelId: "x", headers: {} },
      }),
    });
    const result = await pollVideoJob(model, { id: "t" });
    expect(result).toEqual({ state: "failed", errorMessage: "内容审核未通过" });
  });
});

describe("createVideoJobDriver（取消两层语义）", () => {
  it("未注入厂商取消器：cancel 抛 video_cancel_unsupported（引擎本地软取消）", async () => {
    const driver = createVideoJobDriver({ model: stubModel() });
    await expect(driver.cancel({ id: "t" })).rejects.toMatchObject({
      code: "video_cancel_unsupported",
    });
  });

  it("注入厂商取消器：以 operation 调用并透传请求头", async () => {
    const cancelProviderJob = vi.fn().mockResolvedValue(undefined);
    const driver = createVideoJobDriver({
      model: stubModel(),
      cancelProviderJob,
    });
    await driver.cancel({ id: "t" }, { headers: { "x-c": "1" } });
    expect(cancelProviderJob).toHaveBeenCalledWith(
      { id: "t" },
      { headers: { "x-c": "1" } },
    );
  });

  it("driver.submit / driver.poll 与自由函数同路", async () => {
    const driver = createVideoJobDriver({
      model: stubModel({
        doStart: vi.fn().mockResolvedValue({
          operation: "op-1",
          warnings: [],
          response: { timestamp: new Date(), modelId: "x", headers: {} },
        }),
        doStatus: vi.fn().mockResolvedValue({
          status: "pending",
          response: { timestamp: new Date(), modelId: "x", headers: {} },
        }),
      }),
    });
    const handle = await driver.submit({ prompt: "p" });
    expect(handle.operation).toBe("op-1");
    await expect(driver.poll(handle.operation)).resolves.toEqual({
      state: "in_progress",
    });
  });
});
