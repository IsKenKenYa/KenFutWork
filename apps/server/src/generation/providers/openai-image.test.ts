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
  body: FormData | string | undefined;
};

function captureFetch(responds: Array<unknown>) {
  const requests: Captured[] = [];
  let index = 0;
  const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const rawBody = init?.body;
    const request: Captured = {
      url: String(_input),
      contentType: String(
        new Headers(init?.headers).get("content-type") ?? "",
      ),
      body:
        rawBody instanceof FormData
          ? rawBody
          : typeof rawBody === "string"
            ? rawBody
            : undefined,
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

  it("响应无 url → no_output（既有语义保留）", async () => {
    captureFetch([{ data: [{ b64_json: "aGk=" }] }]);
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    await expect(
      provider.generate({ model: "m", prompt: "p", aspectRatio: "1:1" }),
    ).rejects.toMatchObject({ code: "no_output" });
  });
});

describe("OpenAIImageProvider（编辑路径 S5）", () => {
  it("带参考图 → /images/edits multipart：model/prompt/image 字段齐、凭证头不丢", async () => {
    const requests = captureFetch([
      { data: [{ url: "https://cdn.example/edited.png" }] },
    ]);
    const provider = new OpenAIImageProvider("sk-key", "https://gw.example/v1");
    const dataUrl =
      "data:image/png;base64,aGVsbG8=";
    const image = await provider.generate({
      model: "gpt-image-1",
      prompt: "把背景改成雪地",
      aspectRatio: "1:1",
      inputImages: [dataUrl],
    });
    expect(image.url).toBe("https://cdn.example/edited.png");
    const request = requests[0];
    expect(request?.url).toBe("https://gw.example/v1/images/edits");
    expect(request?.contentType.startsWith("multipart/form-data")).toBe(true);
    const form = request?.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form?.get("model")).toBe("gpt-image-1");
    expect(form?.get("prompt")).toBe("把背景改成雪地");
    expect(form?.get("image")).not.toBeNull();
  });

  it("多张参考图逐张入 multipart；http URL 参考图先下载再上传", async () => {
    const requests: Captured[] = [];
    const download = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }),
    );
    const upload = vi.fn(
      async () =>
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
        const request: Captured = {
          url,
          contentType: String(
            new Headers(init?.headers).get("content-type") ?? "",
          ),
          body:
            init?.body instanceof FormData
              ? init.body
              : typeof init?.body === "string"
                ? init.body
                : undefined,
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
      inputImages: [
        "https://img.example/a.png",
        "data:image/jpeg;base64,QQ==",
      ],
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gw.example/v1/images/edits");
    const form = requests[0]?.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form?.getAll("image")).toHaveLength(2);
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
