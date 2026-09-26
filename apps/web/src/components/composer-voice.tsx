"use client";

import type { VoiceMode, VoiceRefineContextMessage } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { dedupeRequest } from "@/lib/dedupe-request";
import {
  fetchVoiceSettings,
  refineVoice,
  transcribeVoice,
} from "@/lib/server-api";
import { useHoldToTalk } from "@/lib/use-hold-to-talk";
import type { VoiceRecorder } from "@/lib/voice-audio";

/**
 * 输入框语音接线（三处共用：追问 / 空态 / Design 画布助手）。
 *
 * 三个输入框的交互必须完全一致，故手势、状态行、「没听到语音」的判定、以及方案 B
 * 的完整回路都收在这里，各输入框只负责把结果接进自己的受控 state 写入路径
 * （受控写入见 `lib/composer-edit.ts`：绕开它会让画布助手的自管撤销历史与 React state
 * 脱钩）。
 *
 * 方案 B 的**防误伤三道**（规划 §4.3，缺一不可）：
 * 1. 转录里显示的就是**实际会发出去的完整需求**（不做「显示一套、发另一套」）；
 * 2. 起 run 前约 2 秒可撤销窗口（Esc 或点「等等」即中止）；
 * 3. 改写的耗时如实显示（「正在整理需求…」），不是静默卡住。
 *
 * 文案按《AGENTS.md》「界面文案只写给用户看」：一句说清，不写实现细节。
 */

export interface ComposerVoiceOptions {
  /** 无 token（未登录/纯本地演示态）时不接线：手势退化为普通点击。 */
  accessToken: string | undefined;
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
  /** 注入：转写请求（测试用；默认打 `POST /api/voice/transcribe`）。 */
  transcribe?: (wav: Uint8Array) => Promise<string>;
  /** 注入：需求改写（测试用；默认打 `POST /api/voice/refine`）。 */
  refine?: (input: {
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
  accessToken,
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

  const runTranscribe = useCallback(
    async (wav: Uint8Array) => {
      if (transcribe) {
        return transcribe(wav);
      }
      if (!accessToken) {
        throw new Error("请先登录后再使用语音输入。");
      }
      return transcribeVoice(accessToken, wav);
    },
    [accessToken, transcribe],
  );

  const runRefine = useCallback(
    async (input: {
      text: string;
      recentMessages?: VoiceRefineContextMessage[];
    }) => {
      if (refine) {
        return refine(input);
      }
      if (!accessToken) {
        throw new Error("请先登录后再使用语音输入。");
      }
      return refineVoice(accessToken, input);
    },
    [accessToken, refine],
  );

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
        void runRefine({
          text: trimmed,
          ...(recentMessages && recentMessages.length > 0
            ? { recentMessages }
            : {}),
        })
          .then((prompt) => {
            const finalPrompt = prompt.trim() || trimmed;
            setLoop({
              kind: "armed",
              prompt: finalPrompt,
              remainingMs: undoWindowMs,
            });
          })
          .catch((error: unknown) => {
            // 改写失败**不执行**：宁可不做，也不要拿一段没理顺的话去跑一整轮
            setLoop(null);
            showNotice(
              `没能整理成完整需求，已停在转文本：${
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
      runRefine,
      showNotice,
      undoWindowMs,
    ],
  );

  const cancelLoop = useCallback((reason: "user" | "timeout-done") => {
    setLoop(null);
    if (reason === "user") {
      // 中止有明确反馈：用户点了「等等」要看到「已中止」，否则会以为点了没用
      setNotice("已中止，没有执行。");
    }
  }, []);

  // 撤销窗口：倒计时走完才真的执行
  useEffect(() => {
    if (loop?.kind !== "armed") {
      return;
    }
    const startedAt = Date.now();
    const total = undoWindowMs;
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = total - elapsed;
      if (remaining <= 0) {
        clearInterval(timer);
        const prompt = loop.prompt;
        setLoop(null);
        onAutoSubmit?.(prompt);
        return;
      }
      setLoop({ kind: "armed", prompt: loop.prompt, remainingMs: remaining });
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [loop, onAutoSubmit, undoWindowMs]);

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
    enabled: Boolean(accessToken),
    onTranscript: handleTranscript,
    onError: showNotice,
    transcribe: runTranscribe,
    ...(recorder ? { recorder } : {}),
  });

  const baseStatus =
    voice.statusText === null ? null : (
      <p
        role="status"
        className={`mt-1 text-xs ${
          voice.phase === "error" ? "text-destructive" : "text-muted-foreground"
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
      <p role="status" className="mt-1 text-xs text-muted-foreground">
        正在整理成完整需求…
      </p>
    ) : (
      <div
        role="status"
        className="mt-1 flex items-start gap-2 rounded-md border border-dashed px-2 py-1.5 text-xs"
      >
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground">即将执行：</span>
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
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : (
          baseStatus
        )}
      </>
    ),
  };
}

/**
 * 读当前功能模式（方案 A / B）。三处输入框都会调它，故用 `dedupeRequest` 合并成
 * 一次请求（追问框与空态框在同一页面上）。
 *
 * 读不到就按**默认档**（只转文本）处理：这是规划 §4.1 的默认，也是更保守的一侧
 * ——宁可不自动执行，也不要因为一次读失败就去替用户起 run。
 */
export function useVoiceMode(accessToken: string | undefined): VoiceMode {
  const [mode, setMode] = useState<VoiceMode>("transcribe");
  useEffect(() => {
    if (!accessToken) {
      setMode("transcribe");
      return;
    }
    let cancelled = false;
    void dedupeRequest(`voice-settings:${accessToken}`, () =>
      fetchVoiceSettings(accessToken),
    )
      .then((response) => {
        if (!cancelled) {
          setMode(response.settings.mode);
        }
      })
      .catch(() => {
        // 读不到设置不该弹出报错（用户没主动做什么）：按默认档处理即可
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);
  return mode;
}
