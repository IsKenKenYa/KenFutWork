import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  createInstanceImageProvider,
  createInstanceVideoProvider,
} from "../../providers/replicate/index.js";

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
