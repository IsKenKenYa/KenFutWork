import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  createInstanceImageProvider,
  createInstanceVideoProvider,
} from "../../providers/replicate/index.js";
import type { ImageGenerateParams, VideoGenerateParams } from "../types.js";

let server: Server | undefined;
afterEach(async () => {
  const active = server;
  server = undefined;
  if (active)
    await new Promise<void>((resolve) => active.close(() => resolve()));
});

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
}

it("Replicate大参考图先上传完整文件，再用签名URL提交且不向文件URL发送凭据", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0x5a);
  const inputImage = `data:image/png;base64,${bytes.toString("base64")}`;
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    tenant: string | string[] | undefined;
    body: unknown;
  }> = [];
  let signedUrl = "";
  let uploaded: { mimeType: string; name: string; bytes: Buffer } | undefined;
  server = createServer(async (req, res) => {
    let body: unknown;
    if (req.url === "/gateway/v1/files") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      }).formData();
      const content = form.get("content");
      if (content && typeof content !== "string")
        uploaded = {
          mimeType: content.type,
          name: content.name,
          bytes: Buffer.from(await content.arrayBuffer()),
        };
      body = "multipart";
    } else {
      body = await requestBody(req);
    }
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      tenant: req.headers["x-tenant"],
      body,
    });
    res.writeHead(req.url === "/gateway/v1/files" ? 201 : 200, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/gateway/v1/files"
          ? {
              id: "uploaded-reference",
              content_type: "image/png",
              size: bytes.length,
              urls: { get: signedUrl },
            }
          : { id: "file-prediction", status: "starting", output: null },
      ),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  signedUrl = `http://127.0.0.1:${port}/signed-input?signature=test-only`;
  const provider = createInstanceImageProvider({
    credentials: {
      apiKey: "file-upload-test-key",
      baseUrl: `http://127.0.0.1:${port}/gateway/v1`,
      headers: { "x-tenant": "reference-upload" },
    },
    models: [{ id: "custom-owner/custom-image", name: "Image" }],
  });
  if (!provider.startAsync) throw new Error("Replicate图片异步提交未接线");
  await expect(
    provider.startAsync({
      model: "custom-owner/custom-image",
      prompt: "a cat",
      inputImages: [inputImage],
    }),
  ).resolves.toEqual({ providerJobId: "file-prediction" });
  expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "POST", url: "/gateway/v1/files" },
    {
      method: "POST",
      url: "/gateway/v1/models/custom-owner/custom-image/predictions",
    },
  ]);
  expect(JSON.stringify(requests[1]?.body ?? null).includes("data:")).toBe(
    false,
  );
  expect(requests).toEqual([
    {
      method: "POST",
      url: "/gateway/v1/files",
      authorization: "Bearer file-upload-test-key",
      tenant: "reference-upload",
      body: "multipart",
    },
    {
      method: "POST",
      url: "/gateway/v1/models/custom-owner/custom-image/predictions",
      authorization: "Bearer file-upload-test-key",
      tenant: "reference-upload",
      body: {
        input: {
          prompt: "a cat",
          aspect_ratio: "1:1",
          image_input: [signedUrl],
        },
      },
    },
  ]);
  expect(uploaded?.mimeType).toBe("image/png");
  expect(uploaded?.name).toMatch(/\.png$/);
  expect(uploaded?.bytes.equals(bytes)).toBe(true);
});

it("Replicate图片受理processing后保存句柄，新适配器只续查一次", async () => {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    tenant: string | string[] | undefined;
    prefer: string | string[] | undefined;
    body: unknown;
  }> = [];
  server = createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      tenant: req.headers["x-tenant"],
      prefer: req.headers.prefer,
      body: await requestBody(req),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "prediction-1",
        status: "processing",
        output: null,
      }),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const options = {
    credentials: {
      apiKey: "replicate-test-key",
      baseUrl: `http://127.0.0.1:${port}/gateway/v1/`,
      headers: { "x-tenant": "media-tests" },
    },
    models: [{ id: "custom-owner/custom-image", name: "Custom image" }],
  };
  const submitted = createInstanceImageProvider(options);
  if (!submitted.startAsync) throw new Error("Replicate图片异步提交未接线");
  const handle = await submitted.startAsync({
    model: "custom-owner/custom-image",
    prompt: "a cat",
    inputImages: ["https://assets.example/reference.png"],
  });
  expect(handle).toEqual({ providerJobId: "prediction-1" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    method: "POST",
    url: "/gateway/v1/models/custom-owner/custom-image/predictions",
    authorization: "Bearer replicate-test-key",
    tenant: "media-tests",
    prefer: undefined,
    body: {
      input: {
        prompt: "a cat",
        aspect_ratio: "1:1",
        image_input: ["https://assets.example/reference.png"],
      },
    },
  });

  const restarted = createInstanceImageProvider(options);
  if (!restarted.pollAsync) throw new Error("Replicate图片异步查询未接线");
  await expect(restarted.pollAsync(handle.providerJobId)).resolves.toEqual({
    state: "in_progress",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    method: "GET",
    url: "/gateway/v1/predictions/prediction-1",
    authorization: "Bearer replicate-test-key",
    tenant: "media-tests",
    body: null,
  });
});

it("Replicate图片取消调用实例地址的cancel端点且不重新提交", async () => {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    tenant: string | string[] | undefined;
  }> = [];
  server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      tenant: req.headers["x-tenant"],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "prediction-cancel", status: "canceled" }));
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const provider = createInstanceImageProvider({
    credentials: {
      apiKey: "cancel-test-key",
      baseUrl: `http://127.0.0.1:${port}/gateway/v1`,
      headers: { "x-tenant": "cancel-tests" },
    },
    models: [{ id: "custom/image", name: "Image" }],
  });
  if (!provider.cancelAsync) throw new Error("Replicate图片远端取消未接线");
  await provider.cancelAsync("prediction-cancel");
  expect(requests).toEqual([
    {
      method: "POST",
      url: "/gateway/v1/predictions/prediction-cancel/cancel",
      authorization: "Bearer cancel-test-key",
      tenant: "cancel-tests",
    },
  ]);
});

it("Replicate已知视频分支显式音频false和true均实际发送", async () => {
  const branches = [
    {
      model: "kwaivgi/kling-v3-video",
      endpoint: "kwaivgi/kling-v3-video",
      field: "audio",
    },
    {
      model: "bytedance/seedance-1.5-pro",
      endpoint: "bytedance/seedance-1.5-pro",
      field: "audio",
    },
    {
      model: "wan-video/wan-2.6",
      endpoint: "wan-video/wan-2.6-t2v",
      field: "enable_audio",
    },
    {
      model: "google/veo-3",
      endpoint: "google/veo-3",
      field: "generate_audio",
    },
    {
      model: "google/veo-3.1",
      endpoint: "google/veo-3.1",
      field: "generate_audio",
    },
  ] as const;
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    body: unknown;
  }> = [];
  server = createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      body: await requestBody(req),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "audio-prediction",
        status: "starting",
        output: null,
      }),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const provider = createInstanceVideoProvider({
    credentials: {
      apiKey: "audio-test-key",
      baseUrl: `http://127.0.0.1:${port}/gateway/v1`,
    },
    models: branches.map(({ model }) => ({ id: model, name: model })),
  });
  if (!provider.startAsync) throw new Error("Replicate视频异步接口未接线");

  for (const { model, endpoint, field } of branches) {
    for (const enableAudio of [false, true]) {
      await provider.startAsync({ model, prompt: "一只猫", enableAudio });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: `/gateway/v1/models/${endpoint}/predictions`,
        body: { input: { [field]: enableAudio } },
      });
      requests.length = 0;
    }
  }
});

it("Replicate自定义视频模型用实例地址单次提交、续查与取消", async () => {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    tenant: string | string[] | undefined;
    body: unknown;
  }> = [];
  server = createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      tenant: req.headers["x-tenant"],
      body: await requestBody(req),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "custom-video-1",
        status: "processing",
        output: null,
      }),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const options = {
    credentials: {
      apiKey: "video-test-key",
      baseUrl: `http://127.0.0.1:${port}/gateway/v1`,
      headers: { "x-tenant": "video-tests" },
    },
    models: [{ id: "custom-owner/custom-video", name: "Custom video" }],
  };
  const provider = createInstanceVideoProvider(options);
  if (!provider.cancelAsync) throw new Error("Replicate视频远端取消未接线");
  if (!provider.startAsync || !provider.pollAsync)
    throw new Error("Replicate视频异步接口未接线");
  const handle = await provider.startAsync({
    model: "custom-owner/custom-video",
    prompt: "pan to the cat",
    resolution: "1080p",
    duration: 8,
    aspectRatio: "9:16",
    enableAudio: false,
  });
  const restarted = createInstanceVideoProvider(options);
  if (!restarted.pollAsync) throw new Error("Replicate视频异步查询未接线");
  await expect(restarted.pollAsync(handle.providerJobId)).resolves.toEqual({
    state: "in_progress",
  });
  await provider.cancelAsync(handle.providerJobId);
  expect(requests).toEqual([
    {
      method: "POST",
      url: "/gateway/v1/models/custom-owner/custom-video/predictions",
      authorization: "Bearer video-test-key",
      tenant: "video-tests",
      body: {
        input: {
          prompt: "pan to the cat",
          resolution: "1080p",
          duration: 8,
          aspect_ratio: "9:16",
          generate_audio: false,
        },
      },
    },
    {
      method: "GET",
      url: "/gateway/v1/predictions/custom-video-1",
      authorization: "Bearer video-test-key",
      tenant: "video-tests",
      body: null,
    },
    {
      method: "POST",
      url: "/gateway/v1/predictions/custom-video-1/cancel",
      authorization: "Bearer video-test-key",
      tenant: "video-tests",
      body: null,
    },
  ]);
});

it("Replicate视频兼容续查忽略回执给出的不可信URL", async () => {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
  }> = [];
  let baseUrl = "";
  server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.method === "POST"
          ? {
              id: "trusted-prediction",
              status: "processing",
              output: null,
              urls: { get: `${baseUrl}/untrusted-credential-target` },
            }
          : {
              id: "trusted-prediction",
              status: "succeeded",
              output: "https://assets.example/video.mp4",
            },
      ),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/gateway/v1`;
  const provider = createInstanceVideoProvider({
    credentials: { apiKey: "trusted-test-key", baseUrl },
    models: [{ id: "wan-video/wan-2.6", name: "Wan" }],
  });
  await expect(
    provider.generate({ model: "wan-video/wan-2.6", prompt: "a cat" }),
  ).resolves.toMatchObject({ url: "https://assets.example/video.mp4" });
  expect(requests).toEqual([
    {
      method: "POST",
      url: "/gateway/v1/models/wan-video/wan-2.6-t2v/predictions",
      authorization: "Bearer trusted-test-key",
    },
    {
      method: "GET",
      url: "/gateway/v1/predictions/trusted-prediction",
      authorization: "Bearer trusted-test-key",
    },
  ]);
}, 15_000);

it("Replicate版本模型ID通过通用predictions接口提交并保留完整版本", async () => {
  const requests: Array<{ url: string | undefined; body: unknown }> = [];
  server = createServer(async (req, res) => {
    requests.push({ url: req.url, body: await requestBody(req) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "version-prediction",
        status: "starting",
        output: null,
      }),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const version =
    "5c7d5dc6dd8bf75c1acaa8565735e7986bc5b66206b55cca93cb72c9bf15ccaa";
  for (const model of [`custom/image:${version}`, version]) {
    const provider = createInstanceImageProvider({
      credentials: {
        apiKey: "version-test-key",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
      models: [{ id: model, name: "Versioned image" }],
    });
    if (!provider.startAsync) throw new Error("Replicate图片异步提交未接线");
    await expect(
      provider.startAsync({ model, prompt: "a cat" }),
    ).resolves.toEqual({ providerJobId: "version-prediction" });
  }
  expect(requests).toEqual([
    {
      url: "/v1/predictions",
      body: {
        version: `custom/image:${version}`,
        input: { prompt: "a cat", aspect_ratio: "1:1" },
      },
    },
    {
      url: "/v1/predictions",
      body: { version, input: { prompt: "a cat", aspect_ratio: "1:1" } },
    },
  ]);
});

it("Replicate已知不支持的选项明确拒绝，未知原生参数与GPT质量原样发送", async () => {
  const requests: Array<{ url: string | undefined; body: unknown }> = [];
  server = createServer(async (req, res) => {
    requests.push({ url: req.url, body: await requestBody(req) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "parameter-prediction",
        status: "starting",
        output: null,
      }),
    );
  });
  const active = server;
  await new Promise<void>((resolve) => active.listen(0, "127.0.0.1", resolve));
  const { port } = active.address() as AddressInfo;
  const credentials = {
    apiKey: "parameters-test-key",
    baseUrl: `http://127.0.0.1:${port}/v1`,
  };
  const image = createInstanceImageProvider({ credentials, models: [] });
  const video = createInstanceVideoProvider({ credentials, models: [] });
  const startImage = image.startAsync;
  const startVideo = video.startAsync;
  if (!startImage || !startVideo) throw new Error("Replicate异步接口未接线");

  const unsupportedImages: ImageGenerateParams[] = [
    {
      model: "google/imagen-4",
      prompt: "拒绝参考图",
      inputImages: ["https://assets.example/reference.png"],
    },
    {
      model: "black-forest-labs/flux-kontext-pro",
      prompt: "拒绝多参考图",
      inputImages: [
        "https://assets.example/first.png",
        "https://assets.example/second.png",
      ],
    },
    {
      model: "openai/gpt-image-1.5",
      prompt: "不自动改比例",
      aspectRatio: "16:9",
    },
    { model: "google/imagen-4", prompt: "不把4K改2K", quality: "ultra" },
    {
      model: "bytedance/seedream-4",
      prompt: "不忽略格式",
      outputFormat: "webp",
    },
  ];
  const unsupportedVideos: VideoGenerateParams[] = [
    {
      model: "google/veo-3",
      prompt: "拒绝视频参考图",
      inputImages: ["https://assets.example/reference.png"],
    },
    {
      model: "wan-video/wan-2.6",
      prompt: "不丢第二张图",
      inputImages: [
        "https://assets.example/first.png",
        "https://assets.example/second.png",
      ],
    },
  ];
  const rejected = await Promise.allSettled([
    ...unsupportedImages.map((params) => startImage(params)),
    ...unsupportedVideos.map((params) => startVideo(params)),
  ]);
  expect.soft(rejected).toEqual(
    Array.from({ length: 7 }, () => ({
      status: "rejected",
      reason: expect.objectContaining({
        code: expect.stringMatching(/^unsupported(?:_input|_parameter)?$/),
      }),
    })),
  );
  expect.soft(requests).toEqual([]);

  await startImage({
    model: "custom-owner/native-image",
    prompt: "原生参数",
    aspectRatio: "21:9",
    quality: "studio",
    width: 1536,
    height: 640,
    outputFormat: "webp",
  });
  await startImage({
    model: "openai/gpt-image-1.5",
    prompt: "原生GPT质量",
    quality: "low",
  });
  expect
    .soft(
      requests.filter(
        (request) =>
          request.url === "/v1/models/custom-owner/native-image/predictions",
      ),
    )
    .toEqual([
      {
        url: "/v1/models/custom-owner/native-image/predictions",
        body: {
          input: {
            prompt: "原生参数",
            aspect_ratio: "21:9",
            quality: "studio",
            width: 1536,
            height: 640,
            output_format: "webp",
          },
        },
      },
    ]);
  expect
    .soft(
      requests.filter(
        (request) =>
          request.url === "/v1/models/openai/gpt-image-1.5/predictions" &&
          JSON.stringify(request.body).includes("原生GPT质量"),
      ),
    )
    .toEqual([
      {
        url: "/v1/models/openai/gpt-image-1.5/predictions",
        body: {
          input: { prompt: "原生GPT质量", aspect_ratio: "1:1", quality: "low" },
        },
      },
    ]);
});
