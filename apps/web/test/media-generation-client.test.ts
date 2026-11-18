// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  generateImageDirect,
  generateVideoDirect,
} from "../src/lib/server-api";

afterEach(() => vi.unstubAllGlobals());

it("图片提交携带供应商实例、原生模型及参考素材", async () => {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  await generateImageDirect(null, "参考图中的猫", {
    model: "11111111-1111-4111-8111-111111111111:gpt-image-1",
    inputImages: ["https://assets.example/reference.png"],
    outputFormat: "webp",
  });
  expect(requests).toEqual([
    {
      providerInstanceId: "11111111-1111-4111-8111-111111111111",
      model: "gpt-image-1",
      prompt: "参考图中的猫",
      inputImages: ["https://assets.example/reference.png"],
      outputFormat: "webp",
    },
  ]);
});

it("视频提交保留首尾帧、音频及原生模型名中的冒号", async () => {
  let body: unknown;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  await generateVideoDirect(null, "首尾帧转场", {
    model: "11111111-1111-4111-8111-111111111111:owner/video:version",
    inputImages: [
      "https://assets.example/first.png",
      "https://assets.example/last.png",
    ],
    enableAudio: false,
  });
  expect(body).toMatchObject({
    providerInstanceId: "11111111-1111-4111-8111-111111111111",
    model: "owner/video:version",
    inputImages: [
      "https://assets.example/first.png",
      "https://assets.example/last.png",
    ],
    enableAudio: false,
  });
});

it("非UUID的36位前缀仍是原生模型名", async () => {
  let body: unknown;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  await generateImageDirect(null, "猫", {
    model: "------------------------------------:custom-model",
    providerInstanceId: "11111111-1111-4111-8111-111111111111",
  });
  expect(body).toMatchObject({
    model: "------------------------------------:custom-model",
  });
});
