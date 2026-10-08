"use client";

/**
 * 输入框语音接线的核心编排（Design 画布助手与 Code 模式 ZCode 输入框共用）。
 *
 * 手势、状态行、方案 A/B 的完整回路收在这里；各宿主只负责：
 * - 注入 transport（`transcribe` / `refine`——转写与改写的请求形态由宿主决定）；
 * - 把 `onTranscript` 的结果写进自己的受控文本通道（绕开它会与撤销历史脱钩）；
 * - 给了 `onAutoSubmit` 才走方案 B（没有执行入口时不摆「自动执行」的空开关）。
 *
 * 方案 B 的**防误伤三道**（规划 §4.3，缺一不可）：
 * 1. 转录里显示的就是**实际会发出去的完整需求**（不做「显示一套、发另一套」）；
 * 2. 起 run 前约 2 秒可撤销窗口（Esc 或点「等等」即中止）；
 * 3. 改写的耗时如实显示（「正在整理需求…」），不是静默卡住。
 *
 * 文案按《AGENTS.md》「界面文案只写给用户看」：一句说清，不写实现细节。
 */

import type {
  VoiceMode,
  VoiceRefineContextMessage,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { useHoldToTalk } from "./use-hold-to-talk.js";
import type { VoiceRecorder } from "./voice-audio.js";

export interface ComposerVoiceOptions {
  /** 方案 A（只转文本）：拿到文本填进输入框（**保证非空**）。 */
  onTranscript: (text: string) => void;
  /**
   * 方案 B（完整回路）：口述经「想」段补成完整需求后**自动执行**。
   * 给定它 + `mode === "loop"` 才走方案 B；没给则始终按方案 A（没有执行入口时
   * 不摆「自动执行」的空开关）。
   */
  onAutoSubmit?: (prompt: string) => void;
  /** 当前功能模式（来自设置）。 */
  mode?: VoiceMode;
  /** 最近几条会话消息（指代消解用：「刚才那个按钮」）。 */
  recentMessages?: VoiceRefineContextMessage[];
  /** 撤销窗口时长（规划 §4.3 第 2 条：约 2 秒）。测试可调小。 */
  undoWindowMs?: number;
  /** 注入：录音器（测试用；默认浏览器实现）。 */
  recorder?: VoiceRecorder;
  /** 转写请求（必注入：宿主用自己的鉴权与传输打 `/api/voice/transcribe`）。 */
  transcribe: (wav: Uint8Array) => Promise<string>;
  /** 需求改写（必注入：宿主用自己的鉴权与传输打 `/api/voice/refine`）。 */
  refine: (input: {
    text: string;
    recentMessages?: VoiceRefineContextMessage[];
  }) => Promise<string>;
}

export interface ComposerVoiceBinding {
  /** 摊在输入容器上（起手判定；不影响光标定位与拖选）。 */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  /** 录音期间临时禁选。 */
  lockSelection: boolean;
  /** 状态行（null = 不显示）。放到输入框下方同一位置。 */
  status: React.ReactNode;
}

/** 「没听到语音」这类提示的自动收起时长。 */
const NOTICE_MS = 3_000;
/** 撤销窗口（规划 §4.3 第 2 条）。 */
const DEFAULT_UNDO_WINDOW_MS = 2_000;
/** 倒计时刷新间隔（要看起来是在走，又不至于每帧重渲染）。 */
const COUNTDOWN_TICK_MS = 100;

/** 方案 B 的阶段：改写中 → 待执行（撤销窗口倒计时）→ 执行完毕。 */
type LoopStage =
  | { kind: "refining" }
  | { kind: "armed"; prompt: string; remainingMs: number }
  | null;

export function useComposerVoice({
  onTranscript,
  onAutoSubmit,
  mode = "transcribe",
  recentMessages,
  undoWindowMs = DEFAULT_UNDO_WINDOW_MS,
  recorder,
  transcribe,
  refine,
}: ComposerVoiceOptions): ComposerVoiceBinding {
  const [notice, setNotice] = useState<string | null>(null);
  const [loop, setLoop] = useState<LoopStage>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    };
  }, []);

  const handleTranscript = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        // 服务端回空 = 「这段里没有说话」（VAD 判全静音也会走到这里）：
        // 给一句提示，而不是往输入框里塞空白（用户会以为坏了）
        showNotice("没听到语音，再说一次试试。");
        return;
      }
      setNotice(null);
      // 方案 B：先补成完整需求，再进撤销窗口；没给自动执行入口就老实按方案 A
      if (mode === "loop" && onAutoSubmit) {
        setLoop({ kind: "refining" });
        void refine({
          text: trimmed,
          ...(recentMessages && recentMessages.length > 0
            ? { recentMessages }
            : {}),
        })
          .then((prompt) => {
            const finalPrompt = prompt.trim() || trimmed;
            armedRef.current = { prompt: finalPrompt, startedAt: Date.now() };
            setLoop({
              kind: "armed",
              prompt: finalPrompt,
              remainingMs: undoWindowMs,
            });
          })
          .catch((error: unknown) => {
            // 改写失败**不执行**：宁可不做，也不要拿一段没理顺的话去跑一整轮
            armedRef.current = null;
            setLoop(null);
            showNotice(
              `没能整理成完整需求 · 已停在转文本：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            onTranscript(trimmed);
          });
        return;
      }
      onTranscript(trimmed);
    },
    [
      mode,
      onAutoSubmit,
      onTranscript,
      recentMessages,
      refine,
      showNotice,
      undoWindowMs,
    ],
  );

  const cancelLoop = useCallback((reason: "user" | "timeout-done") => {
    armedRef.current = null;
    setLoop(null);
    if (reason === "user") {
      // 中止有明确反馈：用户点了「等等」要看到「已中止」，否则会以为点了没用
      setNotice("已中止，没有执行。");
    }
  }, []);

  /**
   * 撤销窗口：倒计时走完才真的执行。
   *
   * **心跳不能把 `loop` 当依赖**：心跳自己会 `setLoop` 更新剩余毫秒，若 effect 依赖
   * `loop`，每跳都会重启计时器、`startedAt` 跟着重置，倒计时永远停在 2 秒、**永不执行**
   * ——真机点出来过（界面一直显示「等等（2s）」，run 从来没起）。故起点与提示词放 ref，
   * 依赖只看「是不是 armed」这个布尔量。
   */
  const armedRef = useRef<{ prompt: string; startedAt: number } | null>(null);
  const autoSubmitRef = useRef(onAutoSubmit);
  autoSubmitRef.current = onAutoSubmit;
  const armed = loop?.kind === "armed";

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setInterval(() => {
      const current = armedRef.current;
      if (!current) {
        clearInterval(timer);
        return;
      }
      const remaining = undoWindowMs - (Date.now() - current.startedAt);
      if (remaining <= 0) {
        clearInterval(timer);
        armedRef.current = null;
        setLoop(null);
        autoSubmitRef.current?.(current.prompt);
        return;
      }
      setLoop({
        kind: "armed",
        prompt: current.prompt,
        remainingMs: remaining,
      });
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [armed, undoWindowMs]);

  // 撤销窗口内按 Esc 中止（与录音的 Esc 丢弃同一个直觉）
  useEffect(() => {
    if (loop === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelLoop("user");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelLoop, loop]);

  const voice = useHoldToTalk({
    enabled: true,
    onTranscript: handleTranscript,
    onError: showNotice,
    transcribe,
    ...(recorder ? { recorder } : {}),
  });

  const baseStatus =
    voice.statusText === null ? null : (
      <p
        role="status"
        className={`mt-1 text-xs ${
          voice.phase === "error" ? "text-destructive" : "text-foreground-subtle"
        }`}
      >
        {voice.phase === "recording"
          ? `${voice.statusText} · 松开转文字`
          : voice.statusText}
      </p>
    );

  /** 方案 B 的状态行：完整需求 + 倒计时 + 「等等」——**显示的就是将要发出的那句话**。 */
  const loopStatus =
    loop === null ? null : loop.kind === "refining" ? (
      <p role="status" className="mt-1 text-xs text-foreground-subtle">
        正在整理成完整需求…
      </p>
    ) : (
      <div
        role="status"
        className="mt-1 flex items-start gap-2 rounded-md border border-dashed px-2 py-1.5 text-xs"
      >
        <span className="min-w-0 flex-1">
          <span className="text-foreground-subtle">即将执行：</span>
          {loop.prompt}
        </span>
        <button
          type="button"
          onClick={() => cancelLoop("user")}
          className="shrink-0 rounded border px-1.5 py-0.5"
        >
          等等（{Math.ceil(loop.remainingMs / 1000)}s）
        </button>
      </div>
    );

  return {
    onPointerDown: voice.onPointerDown,
    lockSelection: voice.lockSelection,
    status: loopStatus ?? (
      <>
        {notice ? (
          <p role="status" className="mt-1 text-xs text-foreground-subtle">
            {notice}
          </p>
        ) : (
          baseStatus
        )}
      </>
    ),
  };
}
