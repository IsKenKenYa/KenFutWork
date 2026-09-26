import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerVoice } from "../src/components/composer-voice.js";
import type { VoiceRecorder } from "../src/lib/voice-audio.js";

/**
 * 三处输入框共用的语音接线：手势 → 状态行 → 文本落进受控 state。
 * 手势状态机本身在 use-hold-to-talk.test.tsx 已覆盖，这里锁**接线口径**：
 * 空结果给提示而不插空串、服务端失败原因原样显示、未登录不接线。
 *
 * 用组件挂载（而不是 renderHook）：状态行是 ReactNode，必须真的渲染出来
 * 才能断言用户看到什么。
 */

function fakeRecorder(): { recorder: VoiceRecorder; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    recorder: {
      async start() {
        calls.push("start");
        return {
          async stop() {
            calls.push("stop");
            return { wav: new Uint8Array(64), durationMs: 500 };
          },
          discard() {
            calls.push("discard");
          },
        };
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // 本仓 vitest 未开 globals，Testing Library 的自动清理不会生效：手动清，
  // 否则上一轮的组件留在 body 里，getByTestId 会命中多个
  cleanup();
});

interface SetupOptions {
  /** 传 `null` 表示「未登录」场景。 */
  accessToken?: string | null;
  text?: string;
  fail?: string;
}

function setup(options: SetupOptions = {}) {
  const received: string[] = [];
  const { recorder, calls } = fakeRecorder();
  const transcribe = vi.fn(async () => {
    if (options.fail) {
      throw new Error(options.fail);
    }
    return options.text ?? "把首页按钮改成蓝色";
  });
  const accessToken =
    options.accessToken === null ? undefined : (options.accessToken ?? "tok");

  function Harness() {
    const voice = useComposerVoice({
      accessToken,
      onTranscript: (text) => received.push(text),
      recorder,
      transcribe,
    });
    return (
      <div
        data-testid="composer"
        onPointerDown={voice.onPointerDown}
        style={voice.lockSelection ? { userSelect: "none" } : undefined}
      >
        <textarea aria-label="输入消息" />
        {voice.status}
      </div>
    );
  }

  const view = render(<Harness />);
  const composer = view.getByTestId("composer");

  const press = () =>
    fireEvent.pointerDown(composer, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });

  /** 按住 → 松手，走完整一轮（越过 200ms 阈值）。 */
  const hold = async (holdMs = 300) => {
    press();
    await act(async () => {
      vi.advanceTimersByTime(holdMs);
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });
  };

  return { ...view, received, calls, hold, press, composer, transcribe };
}

describe("useComposerVoice", () => {
  it("未登录（无 token）：手势不接线，按住不录音也不报错", async () => {
    const h = setup({ accessToken: null });
    await h.hold();
    expect(h.calls).toEqual([]);
    expect(h.received).toEqual([]);
    expect(h.queryByRole("status")).toBeNull();
  });

  it("空闲时不占位（没有状态行，界面不留空行）", () => {
    const h = setup();
    expect(h.queryByRole("status")).toBeNull();
    expect(h.composer.style.userSelect).toBe("");
  });

  it("正常一轮：文本经 trim 后落进 state，状态行收回到无", async () => {
    const h = setup({ text: "  把首页按钮改成蓝色  " });
    await h.hold();
    expect(h.received).toEqual(["把首页按钮改成蓝色"]);
    expect(h.queryByRole("status")).toBeNull();
    expect(h.composer.style.userSelect).toBe("");
  });

  it("空结果：给「没听到语音」提示，**不**往输入框插空串", async () => {
    const h = setup({ text: "   " });
    await h.hold();
    expect(h.received).toEqual([]);
    expect(h.getByRole("status").textContent).toContain("没听到语音");

    // 提示会自动收起，不留常驻噪声
    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    expect(h.queryByRole("status")).toBeNull();
  });

  it("服务端失败原因原样显示（未下载模型这类话直接给用户看）", async () => {
    const h = setup({
      fail: "未选择「听」模型。到「设置 → 语音」选一个（内置模型需先下载）。",
    });
    await h.hold();
    expect(h.received).toEqual([]);
    expect(h.getByRole("status").textContent).toContain("设置 → 语音");
  });

  it("录音期间：状态行提示「松开转文字」并临时禁选", async () => {
    const h = setup();
    h.press();
    // 起手阶段（未满 200ms）还没有状态行
    expect(h.queryByRole("status")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(h.calls).toContain("start");
    expect(h.composer.style.userSelect).toBe("none");
    expect(h.getByRole("status").textContent).toContain("松开转文字");

    fireEvent.pointerUp(window, { pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.calls).toContain("stop");
    expect(h.received).toHaveLength(1);
  });

  it("提前松手（< 200ms）= 普通点击：不录音、无状态行", async () => {
    const h = setup();
    h.press();
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(h.calls).toEqual([]);
    expect(h.queryByRole("status")).toBeNull();
  });
});
