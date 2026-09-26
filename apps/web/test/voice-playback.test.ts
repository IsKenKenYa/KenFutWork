import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVoicePlayback,
  extractSpeakableText,
} from "../src/lib/voice-playback.js";

/**
 * 播报与打断。核心口径：**新的播报必须打断旧的**（叠着播是语音交互里最刺耳的
 * 失败形态），且在途请求也要中止——否则旧音频回来会接着念。
 */

/**
 * 桩音频元素。**不** extends HTMLAudioElement：`onended` 一类处理器的 this 上下文
 * 在 lib.dom 里绑死在 GlobalEventHandlers 上，结构延伸会被 TS 拒；这里只声明用到的面。
 */
interface FakeAudio {
  played: number;
  paused: number;
  src: string;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  play: () => Promise<void>;
  pause: () => void;
}

function fakeAudio(behaviour: { autoplayFails?: boolean } = {}) {
  const elements: FakeAudio[] = [];
  const createAudio = () => {
    const element: FakeAudio = {
      played: 0,
      paused: 0,
      src: "",
      onended: null,
      onerror: null,
      play: vi.fn(async () => {
        element.played += 1;
        if (behaviour.autoplayFails) {
          throw new Error("NotAllowedError");
        }
      }),
      pause: vi.fn(() => {
        element.paused += 1;
      }),
    };
    elements.push(element);
    return element as unknown as HTMLAudioElement;
  };
  return { createAudio, elements };
}

/** 音频响应桩（blob() 给一段可用字节）。 */
function audioResponse() {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

beforeEach(() => {
  // jsdom 有 URL.createObjectURL 吗？没有就补一个桩（只测我们的调用口径）
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:fake"),
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createVoicePlayback", () => {
  it("念完一段：请求带文本与凭证，播完返回 true", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return audioResponse();
    }) as unknown as typeof fetch;
    const { createAudio, elements } = fakeAudio();
    const playback = createVoicePlayback({ createAudio, fetchFn });

    const speaking = playback.speak("tok", "已经改好了");
    // 让 play() 的 promise 与事件走完
    await vi.waitFor(() => {
      expect(elements[0]?.played).toBe(1);
    });
    elements[0]?.onended?.(new Event("ended") as never);
    await expect(speaking).resolves.toBe(true);
    expect(seen[0]?.url).toContain("/api/voice/speak");
    expect(seen[0]?.body).toEqual({ text: "已经改好了" });
  });

  it("空文本不请求（不给端点发无意义调用）", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const playback = createVoicePlayback({ fetchFn });
    await expect(playback.speak("tok", "   ")).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("新播报打断旧播报：旧音频被 pause 且不再念", async () => {
    const fetchFn = vi.fn(async () =>
      audioResponse(),
    ) as unknown as typeof fetch;
    const { createAudio, elements } = fakeAudio();
    const playback = createVoicePlayback({ createAudio, fetchFn });

    const first = playback.speak("tok", "第一句");
    await vi.waitFor(() => {
      expect(elements).toHaveLength(1);
    });
    const second = playback.speak("tok", "第二句");
    await vi.waitFor(() => {
      expect(elements).toHaveLength(2);
    });

    // 第一句被暂停（打断），第一句的 promise 以 false 收尾
    expect(elements[0]?.paused).toBeGreaterThan(0);
    await expect(first).resolves.toBe(false);

    elements[1]?.onended?.(new Event("ended") as never);
    await expect(second).resolves.toBe(true);
  });

  it("stop() 打断在途请求：音频回来也不念（生成号已变）", async () => {
    let release: (() => void) | undefined;
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        init?.signal?.addEventListener("abort", () => resolve());
      });
      return audioResponse();
    }) as unknown as typeof fetch;
    const { createAudio, elements } = fakeAudio();
    const playback = createVoicePlayback({ createAudio, fetchFn });

    const speaking = playback.speak("tok", "很慢的一句");
    playback.stop();
    release?.();
    await expect(speaking).resolves.toBe(false);
    // 关键：没有任何音频元素被真的播放
    expect(elements).toHaveLength(0);
  });

  it("浏览器拒绝自动播放：静默放弃并回 false（不弹错误，不卡住）", async () => {
    const fetchFn = vi.fn(async () =>
      audioResponse(),
    ) as unknown as typeof fetch;
    const { createAudio } = fakeAudio({ autoplayFails: true });
    const playback = createVoicePlayback({ createAudio, fetchFn });
    await expect(playback.speak("tok", "念一句")).resolves.toBe(false);
  });

  it("端点报错：抛出可读原因（调用方决定要不要打扰用户）", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "service_unavailable",
              message: "未选择「说」模型。",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const playback = createVoicePlayback({
      fetchFn,
      createAudio: fakeAudio().createAudio,
    });
    await expect(playback.speak("tok", "念一句")).rejects.toThrow(
      /未选择「说」模型/,
    );
  });

  it("isSpeaking 反映真实状态（播完回到 false）", async () => {
    const fetchFn = vi.fn(async () =>
      audioResponse(),
    ) as unknown as typeof fetch;
    const { createAudio, elements } = fakeAudio();
    const playback = createVoicePlayback({ createAudio, fetchFn });
    expect(playback.isSpeaking()).toBe(false);
    const speaking = playback.speak("tok", "念一句");
    await vi.waitFor(() => {
      expect(playback.isSpeaking()).toBe(true);
    });
    elements[0]?.onended?.(new Event("ended") as never);
    await speaking;
    expect(playback.isSpeaking()).toBe(false);
  });
});

describe("extractSpeakableText（只念该念的）", () => {
  it("剔掉代码块与行内代码：念代码没有意义", () => {
    const text = extractSpeakableText(
      "改好了：\n```ts\nconst a = 1;\n```\n现在按钮是蓝色。",
    );
    expect(text).toContain("改好了");
    expect(text).toContain("现在按钮是蓝色");
    expect(text).not.toContain("const a = 1");
  });

  it("Markdown 记号不念出来（加粗/标题/列表/链接只留文字）", () => {
    expect(
      extractSpeakableText("## 标题\n- **重点**：看 [文档](https://x)"),
    ).toBe("标题 重点：看 文档");
  });

  it("超长回复截断到上限（别让用户等一分钟朗读）", () => {
    const long = "字".repeat(1_000);
    expect(extractSpeakableText(long, 100)).toHaveLength(100);
    // 默认上限是 500（与端点上限一致）
    expect(extractSpeakableText(long)).toHaveLength(500);
  });

  it("全是代码的回复 → 空串（调用方据此不播报）", () => {
    expect(extractSpeakableText("```js\nconsole.log(1)\n```")).toBe("");
  });
});
