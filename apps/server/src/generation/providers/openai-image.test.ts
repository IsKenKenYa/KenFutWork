import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIImageProvider } from "./openai-image.js";

/**
 * openai 图像适配器：编辑路径（S5 缝，inputImages → /images/edits multipart）
 * 与生成路径（行为不变回归）。抓包口径：stub 全局 fetch（openai SDK 走全局
 * fetch），断言「请求打到哪里、multipart 字段齐不齐」，不关心 SDK 内部。
 */

type Captured = {
  url: string;
  contentType: string;
  authorization: string | null;
  body: FormData | undefined;
  json: Record<string, unknown> | undefined;
};

function captureFetch(responds: Array<unknown>) {
  const requests: Captured[] = [];
  let index = 0;
  const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const rawBody = init?.body;
    const headers = new Headers(init?.headers);
    const request: Captured = {
      url: String(_input),
      contentType: String(headers.get("content-type") ?? ""),
      authorization: headers.get("authorization"),
      body: rawBody instanceof FormData ? rawBody : undefined,
      json: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
    };
    requests.push(request);
    const payload = responds[Math.min(index, responds.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIImageProvider（生成路径，行为不变回归）", () => {
  it("GPT官方别名使用标准横图与质量参数", async () => {
    const requests = captureFetch([{ data: [{ b64_json: "aGk=" }] }]);
    await new OpenAIImageProvider("key", "https://gw.example/v1").generate({
      model: "chatgpt-image-latest",
      prompt: "cat",
      aspectRatio: "16:9",
      quality: "hd",
    });
    expect(requests[0]?.json).toMatchObject({
      size: "1536x1024",
      quality: "medium",
    });
  });

  it("DALL-E沿用原请求形状，不接收GPT专用格式或质量", async () => {
    const requests = captureFetch([
      { data: [{ url: "https://cdn.example/image.png" }] },
    ]);
    const image = await new OpenAIImageProvider(
      "key",
      "https://gw.example/v1",
    ).generate({
      model: "dall-e-3",
      prompt: "cat",
      aspectRatio: "1:1",
      quality: "ultra",
      outputFormat: "webp",
    });
    expect(requests[0]?.json).toEqual({
      model: "dall-e-3",
      prompt: "cat",
      size: "1024x1024",
      n: 1,
    });
    expect(image.mimeType).toBe("image/png");
  });
  it("无参考图 → /images/generations，url 响应透传", async () => {
    const requests = captureFetch([
      { data: [{ url: "https://cdn.example/out.png" }] },
    ]);
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    const image = await provider.generate({
      model: "gpt-image-1",
      prompt: "一只猫",
      aspectRatio: "16:9",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gw.example/v1/images/generations");
    expect(requests[0]?.contentType).toBe("application/json");
    expect(image).toMatchObject({
      url: "https://cdn.example/out.png",
      mimeType: "image/png",
    });
  });

  it("响应无产物 → no_output", async () => {
    captureFetch([{ data: [{}] }]);
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    await expect(
      provider.generate({ model: "m", prompt: "p", aspectRatio: "1:1" }),
    ).rejects.toMatchObject({ code: "no_output" });
  });

  it.each([
    ["1:1", "1024x1024", 1024, 1024],
    ["16:9", "1536x1024", 1536, 1024],
    ["9:16", "1024x1536", 1024, 1536],
  ])(
    "GPT Image %s 使用标准尺寸并接收 base64",
    async (aspectRatio, size, width, height) => {
      const requests = captureFetch([{ data: [{ b64_json: "aGk=" }] }]);
      const image = await new OpenAIImageProvider(
        "key",
        "https://gw.example/v1/",
      ).generate({
        model: "gpt-image-1.5",
        prompt: "cat",
        aspectRatio,
        quality: "ultra",
        outputFormat: "webp",
      });
      expect(requests[0]?.url).toBe("https://gw.example/v1/images/generations");
      expect(requests[0]?.json).toMatchObject({
        size,
        quality: "high",
        output_format: "webp",
      });
      expect(image).toEqual({
        url: "data:image/webp;base64,aGk=",
        mimeType: "image/webp",
        width,
        height,
      });
    },
  );
});

describe("OpenAIImageProvider（编辑路径 S5）", () => {
  it("带参考图 → /images/edits multipart：model/prompt/image 字段齐、凭证头不丢", async () => {
    const requests = captureFetch([
      { data: [{ url: "https://cdn.example/edited.png" }] },
    ]);
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const image = await provider.generate({
      model: "gpt-image-1",
      prompt: "把背景改成雪地",
      aspectRatio: "1:1",
      inputImages: [dataUrl],
    });
    expect(image.url).toBe("https://cdn.example/edited.png");
    const request = requests[0];
    expect(request?.url).toBe("https://gw.example/v1/images/edits");
    // content-type 由 fetch 运行时按 FormData 自动补（带 boundary），不在显式头里；
    // 凭证头必须显式在（自定义头在前、凭证在后的合并语义由 body 实例承担分界）
    expect(request?.authorization).toBe("Bearer sk-key");
    const form = request?.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form?.get("model")).toBe("gpt-image-1");
    expect(form?.get("prompt")).toBe("把背景改成雪地");
    expect(form?.get("image")).not.toBeNull();
  });

  it("多张参考图逐张入 multipart；http URL 参考图先下载再上传", async () => {
    const requests: Captured[] = [];
    const download = vi.fn(
      async (_url: string) =>
        new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }),
    );
    const upload = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({ data: [{ url: "https://cdn.example/e.png" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://img.example/")) {
          return download(url);
        }
        const headers = new Headers(init?.headers);
        const request: Captured = {
          url,
          contentType: String(headers.get("content-type") ?? ""),
          authorization: headers.get("authorization"),
          body: init?.body instanceof FormData ? init.body : undefined,
          json: undefined,
        };
        requests.push(request);
        return upload(url);
      }),
    );

    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    await provider.generate({
      model: "gpt-image-1",
      prompt: "融合两张图",
      aspectRatio: "1:1",
      inputImages: ["https://img.example/a.png", "data:image/jpeg;base64,QQ=="],
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gw.example/v1/images/edits");
    const form = requests[0]?.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form?.getAll("image[]")).toHaveLength(2);
  });

  it("GPT编辑同样接收base64，格式/质量随multipart送达", async () => {
    const requests = captureFetch([{ data: [{ b64_json: "aGk=" }] }]);
    const image = await new OpenAIImageProvider(
      "key",
      "https://gw.example/v1/",
    ).generate({
      model: "gpt-image-1",
      prompt: "edit",
      aspectRatio: "9:16",
      inputImages: ["data:image/png;base64,aGk="],
      quality: "standard",
      outputFormat: "jpg",
    });
    expect(requests[0]?.url).toBe("https://gw.example/v1/images/edits");
    const form = requests[0]?.body;
    expect(form?.get("size")).toBe("1024x1536");
    expect(form?.get("quality")).toBe("low");
    expect(form?.get("output_format")).toBe("jpeg");
    expect(image).toMatchObject({
      url: "data:image/jpeg;base64,aGk=",
      mimeType: "image/jpeg",
      width: 1024,
      height: 1536,
    });
  });

  it("URL 参考图下载失败 → api_error 且可读", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    await expect(
      provider.generate({
        model: "gpt-image-1",
        prompt: "p",
        aspectRatio: "1:1",
        inputImages: ["https://img.example/missing.png"],
      }),
    ).rejects.toMatchObject({ code: "api_error" });
  });
});

it("429由共享Job引擎调度，SDK不在一次执行中隐式重发", async () => {
  const request = vi.fn(async () =>
    Response.json(
      { error: { code: "rate_limit_exceeded", message: "模拟限流" } },
      { status: 429, headers: { "Retry-After": "0.001" } },
    ),
  );
  vi.stubGlobal("fetch", request);
  await expect(
    new OpenAIImageProvider(
      "test-only",
      "https://controlled.invalid/v1",
    ).generate({ model: "gpt-image-1", prompt: "cat" }),
  ).rejects.toMatchObject({ code: "api_error" });
  expect(request).toHaveBeenCalledOnce();
});
