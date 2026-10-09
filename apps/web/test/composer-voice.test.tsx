import type { VoiceRecorder } from "@kenfutwork/voice-ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useComposerVoice,
  useVoiceMode,
  VOICE_SETTINGS_CHANGED_EVENT,
} from "../src/components/composer-voice.js";

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
  // useVoiceMode 首读会打设置接口：给个默认档的桩，免得真发请求
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            settings: {
              mode: "transcribe",
              listen: null,
              think: null,
              speak: null,
              speakReplies: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  it("本机 cookie 接入：无 JS token 仍可录音并回填文本", async () => {
    const h = setup({ accessToken: null });
    await h.hold();
    expect(h.calls).toEqual(["start", "stop"]);
    expect(h.received).toEqual(["把首页按钮改成蓝色"]);
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

describe("useComposerVoice · 方案 B（完整回路 + 撤销窗口）", () => {
  interface LoopOptions {
    mode?: "transcribe" | "loop";
    autoSubmit?: boolean;
    refineFails?: string;
    refined?: string;
    undoWindowMs?: number;
  }

  function setupLoop(options: LoopOptions = {}) {
    const transcripts: string[] = [];
    const submitted: string[] = [];
    const { recorder } = fakeRecorder();
    const refine = vi.fn(async () => {
      if (options.refineFails) {
        throw new Error(options.refineFails);
      }
      return (
        options.refined ?? "把首页右上角的按钮改成蓝色，改完在页面上可见。"
      );
    });
    const transcribe = vi.fn(async () => "那个按钮改成蓝的");

    function Harness() {
      const voice = useComposerVoice({
        accessToken: "tok",
        mode: options.mode ?? "loop",
        onTranscript: (text) => transcripts.push(text),
        ...(options.autoSubmit === false
          ? {}
          : { onAutoSubmit: (prompt: string) => submitted.push(prompt) }),
        recorder,
        transcribe,
        refine,
        ...(options.undoWindowMs ? { undoWindowMs: options.undoWindowMs } : {}),
      });
      return (
        <div data-testid="composer" onPointerDown={voice.onPointerDown}>
          <textarea aria-label="输入消息" />
          {voice.status}
        </div>
      );
    }

    const view = render(<Harness />);
    const composer = view.getByTestId("composer");
    const hold = async () => {
      fireEvent.pointerDown(composer, {
        pointerId: 1,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.pointerUp(window, { pointerId: 1 });
      await act(async () => {
        await Promise.resolve();
      });
    };
    return { ...view, transcripts, submitted, hold, refine, composer };
  }

  it("走完整回路：先改写，再在撤销窗口后自动执行（显示的就是要发出去的那句）", async () => {
    const h = setupLoop({ undoWindowMs: 2_000 });
    await h.hold();
    // 改写完成后进入撤销窗口：完整需求已经可见，还没执行
    expect(h.refine).toHaveBeenCalledTimes(1);
    expect(h.submitted).toEqual([]);
    const armed = h.getByRole("status").textContent ?? "";
    expect(armed).toContain("把首页右上角的按钮改成蓝色");
    expect(armed).toContain("等等");
    // 方案 A 的「填进输入框」在方案 B 下不发生（否则会既填又执行）
    expect(h.transcripts).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(h.submitted).toEqual([
      "把首页右上角的按钮改成蓝色，改完在页面上可见。",
    ]);
  });

  it("窗口里点「等等」即中止：不执行，并明确告知已中止", async () => {
    const h = setupLoop();
    await h.hold();
    fireEvent.click(h.getByRole("button", { name: /等等/ }));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(h.submitted).toEqual([]);
    expect(h.getByRole("status").textContent).toContain("已中止，没有执行");
  });

  it("窗口里按 Esc 同样中止（与录音的 Esc 丢弃同一个直觉）", async () => {
    const h = setupLoop();
    await h.hold();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(h.submitted).toEqual([]);
  });

  it("倒计时期间显示剩余秒数（不是静默卡住）", async () => {
    const h = setupLoop({ undoWindowMs: 3_000 });
    await h.hold();
    expect(h.getByRole("button", { name: /等等/ }).textContent).toContain("3s");
    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    expect(h.getByRole("button", { name: /等等/ }).textContent).toContain("2s");
  });

  it("改写失败**不执行**：退回方案 A 把原话填进输入框并说明原因", async () => {
    const h = setupLoop({
      refineFails: "未选择「想」模型：完整回路需要一个对话模型。",
    });
    await h.hold();
    // 只推进 1 秒：提示本身 3 秒后会自动收起，推太久就看不见了（那是另一条口径）
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(h.submitted).toEqual([]);
    expect(h.transcripts).toEqual(["那个按钮改成蓝的"]);
    expect(h.getByRole("status").textContent).toContain("已停在转文本");
    // 改写失败也**不该**留下一个会执行的倒计时
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(h.submitted).toEqual([]);
  });

  it("只转文本模式下不调用改写（方案 A 不花「想」段的钱）", async () => {
    const h = setupLoop({ mode: "transcribe" });
    await h.hold();
    expect(h.refine).not.toHaveBeenCalled();
    expect(h.transcripts).toEqual(["那个按钮改成蓝的"]);
    expect(h.submitted).toEqual([]);
  });

  it("没有自动执行入口时按方案 A 处理（不摆「自动执行」的空开关）", async () => {
    const h = setupLoop({ autoSubmit: false });
    await h.hold();
    expect(h.refine).not.toHaveBeenCalled();
    expect(h.transcripts).toEqual(["那个按钮改成蓝的"]);
  });
});

describe("useVoiceMode（设置页改档同页立刻生效）", () => {
  it("收到设置变更广播即换档：不必重载页面（真机踩过：切到完整回路后按住说话仍按旧档走）", async () => {
    const modes: string[] = [];
    function Harness() {
      const mode = useVoiceMode("tok");
      modes.push(mode);
      return <span data-testid="mode">{mode}</span>;
    }
    const view = render(<Harness />);
    // 首读打的是设置接口，默认档是「只转文本」
    await vi.waitFor(() => {
      expect(view.getByTestId("mode").textContent).toBe("transcribe");
    });

    // 设置页保存后广播
    act(() => {
      window.dispatchEvent(
        new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, {
          detail: { mode: "loop" },
        }),
      );
    });
    await vi.waitFor(() => {
      expect(view.getByTestId("mode").textContent).toBe("loop");
    });
  });

  it("设置响应不含 settings 时保持默认档：不把 undefined 设进 state 崩掉整棵树（workbench-modes 回归）", async () => {
    // 形状异常的 200（老服务端 / 中间层返回别的 JSON）：读设置这条链路必须软着陆
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    function Harness() {
      const mode = useVoiceMode("tok");
      return <span data-testid="mode">{mode}</span>;
    }
    const view = render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    // 停在默认档（只转文本），组件仍在
    expect(view.getByTestId("mode").textContent).toBe("transcribe");
  });
});

describe("撤销窗口的倒计时真的在走（真机踩过：卡在 2s，run 永不执行）", () => {
  function setupArmed() {
    const submitted: string[] = [];
    const { recorder } = fakeRecorder();
    function Harness() {
      const voice = useComposerVoice({
        accessToken: "tok",
        mode: "loop",
        undoWindowMs: 2_000,
        onTranscript: () => undefined,
        onAutoSubmit: (prompt) => submitted.push(prompt),
        recorder,
        transcribe: async () => "那个按钮改成蓝的",
        refine: async () => "把首页右上角的按钮改成蓝色。",
      });
      return (
        <div data-testid="composer" onPointerDown={voice.onPointerDown}>
          <textarea aria-label="输入消息" />
          {voice.status}
        </div>
      );
    }
    const view = render(<Harness />);
    const composer = view.getByTestId("composer");
    return { ...view, submitted, composer };
  }

  async function holdOnce(composer: HTMLElement) {
    fireEvent.pointerDown(composer, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("分次推进时倒计时递减（心跳把 loop 当依赖会导致每跳重启、永远停在初始值）", async () => {
    const h = setupArmed();
    await holdOnce(h.composer);
    const label = () =>
      h.getByRole("button", { name: /等等/ }).textContent ?? "";
    expect(label()).toContain("2s");

    // 关键：**分多次 act 推进**，让 React 在两次推进之间重渲染（这正是真机的样子）
    for (const expected of ["2s", "1s"]) {
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      void expected;
    }
    const afterOneSecond = label();
    expect(afterOneSecond).toMatch(/1s/);

    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    expect(h.submitted).toEqual(["把首页右上角的按钮改成蓝色。"]);
  });
});
