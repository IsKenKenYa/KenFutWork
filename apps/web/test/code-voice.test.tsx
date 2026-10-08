import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceMode, VoiceSettings } from "@kenfutwork/shared";
import type { VoiceRecorder } from "@kenfutwork/voice-ui";

import {
  CodeVoiceProvider,
  useCodeComposerVoice,
  type CodeVoiceTransport,
} from "../src/components/workbench/zcode/voice/binding.js";

/**
 * Code 模式（ZCode 界面）输入框的语音桥：宿主注入 transport → 共用核心编排
 * （`@kenfutwork/voice-ui`）→ 落到 onTranscript / onAutoSubmit。
 *
 * 手势状态机与方案 A/B 的完整回路已在 composer-voice.test 覆盖（同一份核心）；
 * 这里只锁「桥」的两条口径：
 * 1. 没有 Provider 时不接线（返回 null，composer 行为与从前一致）；
 * 2. transport 全部来自注入，功能模式按设置读到的档位换（读失败落默认档）。
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

function settingsFor(mode: VoiceMode): VoiceSettings {
  return { mode, listen: null, think: null, speak: null, speakReplies: false };
}

interface SetupOptions {
  mode?: VoiceMode;
  settingsFail?: boolean;
  withProvider?: boolean;
  enabled?: boolean;
}

function setup(options: SetupOptions = {}) {
  const received: string[] = [];
  const submitted: string[] = [];
  const { recorder, calls } = fakeRecorder();
  const transcribe = vi.fn(async (_wav: Uint8Array) => "把首页按钮改成蓝色");
  const refine = vi.fn(async (input: { text: string }) => {
    return `完整需求：${input.text}`;
  });
  const fetchSettings = vi.fn(async () => {
    if (options.settingsFail) {
      throw new Error("offline");
    }
    return settingsFor(options.mode ?? "transcribe");
  });
  const transport: CodeVoiceTransport = { transcribe, refine, fetchSettings };

  function Harness() {
    const voice = useCodeComposerVoice({
      ...(options.enabled === false ? { enabled: false } : {}),
      recorder,
      onTranscript: (text) => received.push(text),
      onAutoSubmit: (prompt) => submitted.push(prompt),
    });
    if (!voice) {
      return <div data-testid="composer" data-wired="no" />;
    }
    return (
      <div
        data-testid="composer"
        data-wired="yes"
        onPointerDown={voice.onPointerDown}
        style={voice.lockSelection ? { userSelect: "none" } : undefined}
      >
        {voice.status}
      </div>
    );
  }

  const view = render(
    options.withProvider === false ? (
      <Harness />
    ) : (
      <CodeVoiceProvider transport={transport}>
        <Harness />
      </CodeVoiceProvider>
    ),
  );
  const composer = view.getByTestId("composer");

  /** 等首读设置的微任务落定（fake timers 下 Promise 仍需手动排空）。 */
  const settleSettings = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  /** 按住 → 松手，走完整一轮（越过 200ms 阈值）。 */
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

  return {
    ...view,
    composer,
    received,
    submitted,
    calls,
    hold,
    settleSettings,
    transcribe,
    refine,
    fetchSettings,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // 本仓 vitest 未开 globals，Testing Library 的自动清理不会生效：手动清
  cleanup();
});

describe("Code 输入框语音桥（宿主接线）", () => {
  it("无 Provider：不接线（返回 null），按住也不起录音", async () => {
    const h = setup({ withProvider: false });
    expect(h.composer.dataset.wired).toBe("no");
    await h.hold();
    expect(h.calls).toEqual([]);
    expect(h.received).toEqual([]);
  });

  it("enabled=false：输入框禁用/拒绝档时不接线", () => {
    const h = setup({ enabled: false });
    expect(h.composer.dataset.wired).toBe("no");
  });

  it("按住说话 → transport 转写 → 文本落进输入框（只转文本档）", async () => {
    const h = setup();
    await h.settleSettings();
    await h.hold();
    expect(h.calls).toEqual(["start", "stop"]);
    expect(h.transcribe).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(h.received).toEqual(["把首页按钮改成蓝色"]);
    expect(h.refine).not.toHaveBeenCalled();
    expect(h.submitted).toEqual([]);
  });

  it("完整回路档：读设置换档 → 改写 → 撤销窗口后自动提交", async () => {
    const h = setup({ mode: "loop" });
    await h.settleSettings();
    await h.hold();
    expect(h.refine).toHaveBeenCalledTimes(1);
    // 撤销窗口内：显示即将执行的完整需求，还没执行
    const armed = h.getByRole("status").textContent ?? "";
    expect(armed).toContain("即将执行");
    expect(armed).toContain("完整需求：把首页按钮改成蓝色");
    expect(h.submitted).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(h.submitted).toEqual(["完整需求：把首页按钮改成蓝色"]);
  });

  it("设置读失败按默认档（只转文本）：不触发改写与自动执行", async () => {
    const h = setup({ settingsFail: true });
    await h.settleSettings();
    await h.hold();
    expect(h.received).toEqual(["把首页按钮改成蓝色"]);
    expect(h.refine).not.toHaveBeenCalled();
    expect(h.submitted).toEqual([]);
  });
});
