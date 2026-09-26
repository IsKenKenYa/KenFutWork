import { describe, expect, it, vi } from "vitest";

import type { InstanceCredentials } from "../../../providers/types.js";
import { encodeWav } from "../audio.js";
import { createInstanceAudioProvider } from "./openai-audio.js";

/**
 * 在线档 provider 的单测：注入 fetch 桩，把「请求长什么样」钉死
 * （路径 / multipart 字段 / JSON 字段 / 凭证头），并覆盖端点报错的可读性。
 */

function credentials(
  overrides: Partial<InstanceCredentials> = {},
): InstanceCredentials {
  return {
    apiKey: "sk-test",
    baseUrl: "http://127.0.0.1:8000/v1",
    ...overrides,
  };
}

/** 从 multipart body 里取出字段（够用即可：只读文本与文件名，不解析二进制）。 */
async function readMultipart(form: FormData): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  for (const [key, value] of form.entries()) {
    fields.set(
      key,
      typeof value === "string" ? value : `file:${value.name}:${value.type}`,
    );
  }
  return fields;
}

describe("OpenAI 兼容音频 Provider：听（转写）", () => {
  it("POST /audio/transcriptions，multipart 带 model 与 file，返回去空格文本", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ text: "  打开设置页  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials({ headers: { "x-tenant": "acme" } }),
      transcribeModel: "whisper-1",
      fetchFn,
    });

    const result = await provider.transcriber?.transcribe(
      encodeWav(new Float32Array(160), 16_000),
    );
    expect(result?.text).toBe("打开设置页");
    expect(seen[0]?.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(seen[0]?.init.method).toBe("POST");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["x-tenant"]).toBe("acme"); // 自定义头透传（§4.8）
    const fields = await readMultipart(seen[0]?.init.body as FormData);
    expect(fields.get("model")).toBe("whisper-1");
    expect(fields.get("file")).toBe("file:audio.wav:audio/wav");
    expect(fields.has("language")).toBe(false);
  });

  it("语言提示透传（有则带、无则不带）", async () => {
    const bodies: FormData[] = [];
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(init?.body as FormData);
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
      transcribeModel: "whisper-1",
      fetchFn,
    });
    await provider.transcriber?.transcribe(new Uint8Array(), {
      language: "zh",
    });
    expect((await readMultipart(bodies[0] as FormData)).get("language")).toBe(
      "zh",
    );
  });

  it("端点报错：可读中文原因带状态码与响应体", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("model not found", {
          status: 404,
          statusText: "Not Found",
        }),
    ) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
      transcribeModel: "ghost",
      fetchFn,
    });
    await expect(
      provider.transcriber?.transcribe(new Uint8Array(44)),
    ).rejects.toThrow(/HTTP 404.*model not found/s);
  });

  it("端点返回缺 text 字段：fail loud 而不是回 undefined", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
      transcribeModel: "whisper-1",
      fetchFn,
    });
    await expect(
      provider.transcriber?.transcribe(new Uint8Array(44)),
    ).rejects.toThrow(/未返回 text/);
  });

  it("未配转写模型的实例：不给听能力（不摆空壳）", () => {
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
    });
    expect(provider.transcriber).toBeUndefined();
    expect(provider.synthesizer).toBeUndefined();
  });

  it("缺凭证：ready 报不可用，调用即 fail loud", async () => {
    const provider = createInstanceAudioProvider({
      credentials: credentials({ apiKey: "" }),
      transcribeModel: "whisper-1",
    });
    const verdict = await provider.transcriber?.ready();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.reason).toContain("凭证");
  });
});

describe("OpenAI 兼容音频 Provider：说（合成）", () => {
  it("POST /audio/speech，JSON 带 model/input/voice/response_format=wav，回音频字节", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials({ baseUrl: "http://127.0.0.1:8000/v1/" }),
      speechModel: "tts-1",
      voice: "alloy",
      fetchFn,
    });

    const result = await provider.synthesizer?.synthesize("  你好  ");
    expect(seen[0]?.url).toBe("http://127.0.0.1:8000/v1/audio/speech");
    // baseUrl 尾斜杠要去掉，否则拼出 //audio/speech
    expect(seen[0]?.url).not.toContain("//audio");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      model: "tts-1",
      input: "你好",
      response_format: "wav",
      voice: "alloy",
    });
    expect(result?.mimeType).toBe("audio/wav");
    expect(Array.from(result?.audio ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("调用期 voice 覆盖实例默认音色；未配则不带 voice 字段", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
      speechModel: "tts-1",
      fetchFn,
    });
    await provider.synthesizer?.synthesize("a", { voice: "nova" });
    await provider.synthesizer?.synthesize("b");
    expect((bodies[0] as Record<string, unknown>).voice).toBe("nova");
    expect(bodies[1]).not.toHaveProperty("voice");
  });

  it("合成失败：可读原因；空文本与未配模型 fail loud", async () => {
    const fetchFn = vi.fn(
      async () => new Response("quota exceeded", { status: 429 }),
    ) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: credentials(),
      speechModel: "tts-1",
      fetchFn,
    });
    await expect(provider.synthesizer?.synthesize("hi")).rejects.toThrow(
      /HTTP 429.*quota exceeded/s,
    );
    await expect(provider.synthesizer?.synthesize("  ")).rejects.toThrow(
      /文本为空/,
    );
    const noModel = createInstanceAudioProvider({
      credentials: credentials(),
      fetchFn,
    });
    expect(noModel.synthesizer).toBeUndefined();
  });

  it("未配 baseUrl 时走 OpenAI 官方地址", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createInstanceAudioProvider({
      credentials: { apiKey: "sk-x" },
      speechModel: "tts-1",
      fetchFn,
    });
    await provider.synthesizer?.synthesize("hi");
    expect(urls[0]).toBe("https://api.openai.com/v1/audio/speech");
  });
});

describe("OpenAI 兼容音频 Provider：形状", () => {
  it("只听、只说、听说齐全三种形态的 id 与位置标注", () => {
    const both = createInstanceAudioProvider({
      credentials: credentials(),
      transcribeModel: "whisper-1",
      speechModel: "tts-1",
    });
    expect(both.transcriber).toBeDefined();
    expect(both.synthesizer).toBeDefined();
    expect(both.vad).toBeUndefined(); // 远端不做切句
    expect(both.location).toBe("remote");
    expect(both.id).toContain("127.0.0.1:8000");
  });
});
