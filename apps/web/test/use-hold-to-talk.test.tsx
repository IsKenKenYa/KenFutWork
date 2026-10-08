import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHoldToTalk } from "@kenfutwork/voice-ui";
import type { VoiceRecorder, VoiceRecording } from "@kenfutwork/voice-ui";

/**
 * 手势状态机。这块最容易伤到既有行为（光标定位、拖选、IME），
 * 所以「不该录音」的每一条路径都要有用例：提前松手、拖选、按控件、非主键、
 * Escape、pointercancel，以及异步开麦期间的取消。
 */

/** 可编程假录音器：记录 start/stop/discard，并可指定开麦耗时。 */
function fakeRecorder(
  options: {
    startupDelayMs?: number;
    startError?: Error;
    clipBytes?: number;
  } = {},
) {
  const calls: string[] = [];
  const recorder: VoiceRecorder = {
    async start() {
      calls.push("start");
      if (options.startupDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.startupDelayMs),
        );
      }
      if (options.startError) {
        throw options.startError;
      }
      const recording: VoiceRecording = {
        async stop() {
          calls.push("stop");
          return {
            wav: new Uint8Array(options.clipBytes ?? 64),
            durationMs: 1_000,
          };
        },
        discard() {
          calls.push("discard");
        },
      };
      return recording;
    },
  };
  return { recorder, calls };
}

/** 造一个挂在 body 上的输入容器（手势挂在容器上）。 */
function createComposer() {
  const el = document.createElement("div");
  el.setAttribute("data-test-composer", "");
  const textarea = document.createElement("textarea");
  el.appendChild(textarea);
  document.body.appendChild(el);
  return { el, textarea };
}

/**
 * 造一个 React pointerdown 事件。为什么不用 `new Event()`：`currentTarget` 在 DOM
 * 事件上是只读 getter（React 是派发时填的），测试里赋值会被拒；而 hook 只读
 * target/currentTarget/button/pointerId/clientX/clientY 这几个字段，用普通对象最直接。
 */
function pointerDown(
  target: EventTarget,
  currentTarget: HTMLElement,
  init: { pointerId?: number; button?: number; x?: number; y?: number } = {},
) {
  return {
    pointerId: init.pointerId ?? 1,
    button: init.button ?? 0,
    clientX: init.x ?? 10,
    clientY: init.y ?? 10,
    currentTarget,
    target,
  } as unknown as ReactPointerEvent<HTMLElement>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll("[data-test-composer]").forEach((el) => {
    el.remove();
  });
});

interface HarnessOptions {
  startupDelayMs?: number;
  startError?: Error;
  transcribe?: (wav: Uint8Array) => Promise<string>;
  enabled?: boolean;
  maxClipMs?: number;
}

function setup(options: HarnessOptions = {}) {
  const transcripts: string[] = [];
  const errors: string[] = [];
  const { recorder, calls } = fakeRecorder(options);
  const { el, textarea } = createComposer();
  const view = renderHook(() =>
    useHoldToTalk({
      enabled: options.enabled ?? true,
      recorder,
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => errors.push(message),
      transcribe: options.transcribe ?? (async () => "把首页按钮改成蓝色"),
      ...(options.maxClipMs ? { maxClipMs: options.maxClipMs } : {}),
    }),
  );
  const down = (
    target: EventTarget = textarea,
    init: Parameters<typeof pointerDown>[2] = {},
  ) =>
    act(() => {
      (view.result.current.onPointerDown as unknown as (e: unknown) => void)(
        pointerDown(target, el, init),
      );
    });
  const fire = (type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId: 1, clientX: 10, clientY: 10, ...init });
      window.dispatchEvent(event);
    });
  /** 用起手时指定的 pointerId 派发（指针归属用例需要多根指针）。 */
  const fireFor = (type: string, pointerId: number) =>
    fire(type, { pointerId });
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  /**
   * 放行微任务（假录音器的 start/stop 是 promise）。
   * **不能**用 runAllTimersAsync：录音态的 250ms 计时器是无限 interval，
   * 跑到 10000 个定时器就会被 vitest 判成死循环。需要时间的场景给毫秒数。
   */
  const settle = async (ms = 0) => {
    await act(async () => {
      if (ms > 0) {
        await vi.advanceTimersByTimeAsync(ms);
      } else {
        await Promise.resolve();
      }
    });
  };
  return {
    ...view,
    el,
    textarea,
    transcripts,
    errors,
    calls,
    down,
    fire,
    fireFor,
    advance,
    settle,
  };
}

describe("起手判定：不该录音的路径", () => {
  it("提前松手（< 200ms）= 普通点击，不碰麦克风", async () => {
    const h = setup();
    h.down();
    h.advance(150);
    h.fire("pointerup");
    expect(h.calls).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
    expect(h.transcripts).toEqual([]);
  });

  it("拖选（移动 > 8px）取消起手，且不拦事件（选区照做）", async () => {
    const h = setup();
    h.down();
    h.advance(50);
    h.fire("pointermove", { clientX: 40, clientY: 40 });
    h.advance(400); // 越过 200ms 也不该开麦
    h.fire("pointerup");
    expect(h.calls).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
  });

  it("抖动在 8px 内不算拖选（仍会进入录音）", async () => {
    const h = setup();
    h.down();
    h.advance(50);
    h.fire("pointermove", { clientX: 14, clientY: 15 });
    h.advance(200);
    await h.settle();
    expect(h.calls).toContain("start");
  });

  it("点在工具行控件上不触发：button / [role=button] / select / input", async () => {
    const h = setup();
    for (const tag of ["button", "input", "select"]) {
      const control = document.createElement(tag);
      h.el.appendChild(control);
      h.down(control);
      h.advance(400);
      expect(h.calls, `${tag} 不该触发录音`).toEqual([]);
      control.remove();
    }
    const roleButton = document.createElement("div");
    roleButton.setAttribute("role", "button");
    h.el.appendChild(roleButton);
    h.down(roleButton);
    h.advance(400);
    expect(h.calls).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
  });

  it("非主键（右键/中键）不触发", async () => {
    const h = setup();
    h.down(h.textarea, { button: 2 });
    h.advance(400);
    expect(h.calls).toEqual([]);
  });

  it("关闭时（enabled=false）完全不用：连 phase 都不动", async () => {
    const h = setup({ enabled: false });
    h.down();
    h.advance(400);
    expect(h.calls).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.statusText).toBeNull();
  });
});

describe("正常路径：按住 → 松手 → 转写落地", () => {
  it("满 200ms 开麦，松手提交，文本回调一次", async () => {
    const h = setup();
    h.down();
    h.advance(199);
    expect(h.calls).toEqual([]); // 差 1ms 都不开麦
    h.advance(1);
    await h.settle();
    expect(h.calls).toContain("start");
    expect(h.result.current.phase).toBe("recording");

    h.fire("pointerup");
    await h.settle();
    expect(h.calls).toContain("stop");
    expect(h.transcripts).toEqual(["把首页按钮改成蓝色"]);
    expect(h.result.current.phase).toBe("idle");
  });

  it("录音态给状态条并禁选（0:03 口径）", async () => {
    const h = setup();
    h.down();
    h.advance(200);
    await h.settle();
    expect(h.result.current.lockSelection).toBe(true);
    expect(h.result.current.statusText).toContain("录音中 0:0");

    h.advance(3_000);
    expect(h.result.current.statusText).toBe("录音中 0:03");
  });

  it("空文本也回调（「用户没说」由调用方提示，不是错误）", async () => {
    const h = setup({ transcribe: async () => "" });
    h.down();
    h.advance(200);
    await h.settle();
    h.fire("pointerup");
    await h.settle();
    expect(h.transcripts).toEqual([""]);
    expect(h.errors).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
  });

  it("转写期间显示「转写中…」且不重复起手", async () => {
    let release: (() => void) | undefined;
    const h = setup({
      transcribe: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("好了");
        }),
    });
    h.down();
    h.advance(200);
    await h.settle();
    h.fire("pointerup");
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.result.current.phase).toBe("transcribing");
    expect(h.result.current.statusText).toBe("转写中…");

    // 转写中再按：不该开第二路
    h.down();
    h.advance(400);
    expect(h.calls.filter((call) => call === "start")).toHaveLength(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(h.result.current.phase).toBe("idle");
  });
});

describe("取消与失败", () => {
  it("Escape 丢弃：放掉麦克风、不提交", async () => {
    const h = setup();
    h.down();
    h.advance(200);
    await h.settle();
    h.fire("keydown", { key: "Escape" });
    expect(h.calls).toContain("discard");
    expect(h.calls).not.toContain("stop");
    expect(h.transcripts).toEqual([]);
    expect(h.result.current.phase).toBe("idle");
  });

  it("pointercancel 丢弃", async () => {
    const h = setup();
    h.down();
    h.advance(200);
    await h.settle();
    h.fire("pointercancel");
    expect(h.calls).toContain("discard");
    expect(h.transcripts).toEqual([]);
  });

  it("开麦期间（warming up）就松手：不留孤儿麦克风", async () => {
    const h = setup({ startupDelayMs: 500 });
    h.down();
    h.advance(200); // 触发开麦（start 挂起中）
    h.fire("pointerup"); // 麦克风尚未就绪时松手
    await h.settle(600); // 让挂起的 start 落地
    // 千万不能出现「开着麦但没人收」：启动完成后必须立刻 discard
    expect(h.calls).toContain("start");
    expect(h.calls).toContain("discard");
    expect(h.calls).not.toContain("stop");
    expect(h.result.current.phase).toBe("idle");
  });

  it("开麦期间按下 Escape：同样丢弃（不放孤儿）", async () => {
    const h = setup({ startupDelayMs: 500 });
    h.down();
    h.advance(200);
    h.fire("keydown", { key: "Escape" });
    await h.settle(600);
    expect(h.calls).toContain("discard");
    expect(h.result.current.phase).toBe("idle");
  });

  it("麦克风打不开：报可读原因并回到可重试状态", async () => {
    const h = setup({ startError: new Error("麦克风权限被拒绝。") });
    h.down();
    h.advance(200);
    await h.settle();
    expect(h.result.current.phase).toBe("error");
    expect(h.result.current.statusText).toBe("麦克风权限被拒绝。");
    expect(h.errors).toEqual(["麦克风权限被拒绝。"]);

    act(() => {
      h.result.current.dismissError();
    });
    expect(h.result.current.phase).toBe("idle");

    // 清掉错误后还能再来一轮（不是一次性坏掉）
    h.down();
    h.advance(200);
    await h.settle();
    expect(h.calls.filter((call) => call === "start").length).toBeGreaterThan(
      1,
    );
  });

  it("转写请求失败：错误进状态条，不静默丢", async () => {
    const h = setup({
      transcribe: async () => {
        throw new Error("未下载「听」模型（Speech-to-Text）");
      },
    });
    h.down();
    h.advance(200);
    await h.settle();
    h.fire("pointerup");
    await h.settle();
    expect(h.result.current.phase).toBe("error");
    expect(h.result.current.statusText).toContain("未下载");
    expect(h.transcripts).toEqual([]);
  });

  it("超过录音上限自动停并提交（不无限占麦克风）", async () => {
    const h = setup({ maxClipMs: 1_000 });
    h.down();
    h.advance(200);
    await h.settle();
    h.advance(1_200);
    await h.settle();
    expect(h.calls).toContain("stop");
    expect(h.transcripts).toHaveLength(1);
    expect(h.result.current.phase).toBe("idle");
  });

  it("卸载时丢弃在途录音（麦克风不留在后台）", async () => {
    const h = setup();
    h.down();
    h.advance(200);
    await h.settle();
    h.unmount();
    expect(h.calls).toContain("discard");
  });
});

describe("指针归属（真机踩过：无关点击会把正在录的音提交掉）", () => {
  it("录音期间别的指针松手：不提交（录音继续）", async () => {
    const h = setup();
    h.down(h.textarea, { pointerId: 7 });
    h.advance(300);
    await h.settle();
    expect(h.calls).toContain("start");

    // 页面上另一次点击（别的 pointerId）松手：不该动这次录音
    h.fireFor("pointerup", 1);
    await h.settle();
    expect(h.calls).not.toContain("stop");
    expect(h.transcripts).toEqual([]);
    expect(h.result.current.phase).toBe("recording");

    // 起手那根指针松手才提交
    h.fireFor("pointerup", 7);
    await h.settle();
    expect(h.calls).toContain("stop");
    expect(h.transcripts).toEqual(["把首页按钮改成蓝色"]);
  });

  it("录音期间别的指针被取消：不丢这次录音", async () => {
    const h = setup();
    h.down(h.textarea, { pointerId: 9 });
    h.advance(300);
    await h.settle();

    h.fireFor("pointercancel", 2);
    await h.settle();
    expect(h.calls).not.toContain("discard");
    expect(h.result.current.phase).toBe("recording");

    h.fireFor("pointerup", 9);
    await h.settle();
    expect(h.transcripts).toHaveLength(1);
  });

  it("起手阶段（未满 200ms）别的指针松手：不误清自己的起手", async () => {
    const h = setup();
    h.down(h.textarea, { pointerId: 5 });
    h.advance(100);
    // 别的指针松手：既不该提交，也不该把 5 号的起手计时清掉
    h.fireFor("pointerup", 4);
    h.advance(200);
    await h.settle();
    expect(h.calls).toContain("start");
  });
});
