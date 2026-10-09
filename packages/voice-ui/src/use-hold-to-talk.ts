"use client";

/**
 * 「按住输入框说话」手势（规划 §7）。
 *
 * 判定链（每一步都为「不干扰正常输入」服务）：
 * 1. `pointerdown` 起 200ms 计时；**移动 > 8px 或提前松手 = 普通点击/拖选**，
 *    不录音、不 preventDefault（光标定位与选区照常）；
 * 2. 满 200ms 进录音态并 `setPointerCapture`（手指/鼠标移出输入框也能收到松手）；
 * 3. 松手提交；Escape 或 `pointercancel` 丢弃（丢弃路径必须放掉麦克风）；
 * 4. 命中 `button` / `[role=button]` / `select` / `input` 不触发——按工具行按钮、
 *    拉下拉框、点隐藏的文件输入框都不会误录音。
 *
 * 采集与转写都可注入：jsdom 里没有 getUserMedia/MediaRecorder，
 * 手势状态机则必须能在单测里被完整驱动（含边界与取消路径）。
 *
 * **会话状态机**（`session` ref）是这里最容易写错的地方：`getUserMedia` 是异步的，
 * 用户完全可能在「麦克风正在打开」的那几百毫秒里就松手或按 Escape。只有把
 * `starting`（已起手、麦克风未就绪）单列一态，才不会漏掉「松手后麦克风才打开」
 * ——那会让麦克风一直开着，直到录音上限。
 */

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createBrowserRecorder,
  type VoiceRecorder,
  type VoiceRecording,
} from "./voice-audio.js";

/** 按住多久算录音（规划 §7）。 */
const DEFAULT_HOLD_MS = 200;
/** 起手阶段允许的抖动像素：超过即判为拖选而非长按。 */
const DEFAULT_MOVE_TOLERANCE_PX = 8;
/**
 * 单段录音上限：按住不放（塞兜里、按键卡住）会一直占着麦克风，
 * 到点自动停并提交，别让它无限录下去。
 */
const DEFAULT_MAX_CLIP_MS = 120_000;

export type HoldToTalkPhase =
  | "idle"
  | "arming"
  | "recording"
  | "transcribing"
  | "error";

export interface HoldToTalkOptions {
  /** 关掉即完全不用（未配置语音时输入框行为与从前一致）。 */
  enabled: boolean;
  /** 拿到文本（**空文本也会回调**：用户没说 vs 识别失败由调用方提示区分）。 */
  onTranscript: (text: string) => void;
  /** 失败时可读原因（同时会进 `statusText`）。 */
  onError?: (message: string) => void;
  /** 进入录音态（满 200ms 真的开麦）时回调：宿主据此打断旧播报。 */
  onRecordingStart?: () => void;
  /** 注入：录音器（默认浏览器实现）。 */
  recorder?: VoiceRecorder;
  /** 注入：转写请求（默认无，缺失即报「未接线」）。 */
  transcribe?: (wav: Uint8Array) => Promise<string>;
  holdMs?: number;
  moveTolerancePx?: number;
  maxClipMs?: number;
}

export interface HoldToTalk {
  phase: HoldToTalkPhase;
  /** 状态条文案：录音中 0:03 / 转写中… / 失败原因；idle 时为 null。 */
  statusText: string | null;
  /** 录音期间临时禁选（摊到容器上）。 */
  lockSelection: boolean;
  /** 输入容器的起手处理。 */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 用户手动清掉错误提示。 */
  dismissError: () => void;
}

/** 起手就要放行的交互控件（规划 §7 点名的四类 + 同族控件）。 */
const INTERACTIVE_SELECTOR =
  "button, [role=button], select, input, a, [role=switch], [role=menuitem]";

export function useHoldToTalk(options: HoldToTalkOptions): HoldToTalk {
  const {
    enabled,
    onTranscript,
    onError,
    holdMs = DEFAULT_HOLD_MS,
    moveTolerancePx = DEFAULT_MOVE_TOLERANCE_PX,
    maxClipMs = DEFAULT_MAX_CLIP_MS,
  } = options;

  const recorder = useMemo(
    () => options.recorder ?? createBrowserRecorder(),
    [options.recorder],
  );
  /** 回调放 ref：手势监听只装一次，不该被调用方的每次重渲染反复拆装。 */
  const transcribeRef = useRef(options.transcribe);
  transcribeRef.current = options.transcribe;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onRecordingStartRef = useRef(options.onRecordingStart);
  onRecordingStartRef.current = options.onRecordingStart;

  const [phase, setPhase] = useState<HoldToTalkPhase>("idle");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  /**
   * 会话状态：idle → starting（已起手、麦克风未就绪）→ active（在录）
   * → 提交/丢弃回 idle。`aborted` 表示「用户在 warm-up 期间就撤了」，
   * 由 `start()` 回来后自行丢弃，避免麦克风被遗弃。
   *
   * `pointerId` 一并记住：**只认起手那根指针的松手**。真机踩过——录音期间页面上
   * 任何一次点按（别人的鼠标、工具点击、点工具行按钮）的 pointerup 都会走到
   * window 监听上；不加这一层，一次无关点击就会把正在录的音提交掉。
   */
  const session = useRef<
    | { kind: "idle" }
    | { kind: "starting"; aborted: boolean; pointerId: number }
    | { kind: "active"; recording: VoiceRecording; pointerId: number }
  >({ kind: "idle" });

  /** 起手（未满 200ms）状态；不进 React state：pointermove 逐次读它。 */
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    pointerId: number;
    startX: number;
    startY: number;
    element: HTMLElement;
  } | null>(null);

  const clearPending = useCallback(() => {
    const state = pending.current;
    pending.current = null;
    if (state) {
      clearTimeout(state.timer);
      try {
        if (state.element.hasPointerCapture?.(state.pointerId)) {
          state.element.releasePointerCapture(state.pointerId);
        }
      } catch {
        // 指针早已失效：释放失败无所谓（捕获随指针自动过期）
      }
    }
  }, []);

  /** 丢弃当前会话（放掉麦克风）。`starting` 阶段只能打标记，等 start() 回来收拾。 */
  const discardSession = useCallback(() => {
    const current = session.current;
    session.current = { kind: "idle" };
    if (current.kind === "active") {
      current.recording.discard();
    } else if (current.kind === "starting") {
      current.aborted = true;
    }
    clearPending();
    setPhase("idle");
    setStatusText(null);
  }, [clearPending]);

  const fail = useCallback(
    (message: string) => {
      const current = session.current;
      session.current = { kind: "idle" };
      if (current.kind === "active") {
        current.recording.discard();
      } else if (current.kind === "starting") {
        current.aborted = true;
      }
      clearPending();
      setPhase("error");
      setStatusText(message);
      onErrorRef.current?.(message);
    },
    [clearPending],
  );

  /** 200ms 到点：真正开麦。 */
  const beginRecording = useCallback(
    async (pointerId: number) => {
      pending.current = null;
      const marker = { kind: "starting" as const, aborted: false, pointerId };
      session.current = marker;
      setPhase("recording");
      setElapsedMs(0);
      setStatusText("录音中…");
      // 用户开始说话：宿主的播报（若有）立刻让位——先打断，再开麦
      onRecordingStartRef.current?.();
      try {
        const recording = await recorder.start();
        if (marker.aborted) {
          // 用户在开麦期间就松手/取消了：立刻放掉，不留孤儿麦克风
          recording.discard();
          return;
        }
        session.current = { kind: "active", recording, pointerId };
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    [fail, recorder],
  );

  /** 松手提交：转写 → 回调文本。 */
  const submit = useCallback(async () => {
    const current = session.current;
    if (current.kind === "starting") {
      // 麦克风还没就绪：打标记，等 start() 回来丢弃（不能白等也不能留着）
      current.aborted = true;
      setPhase("idle");
      setStatusText(null);
      return;
    }
    if (current.kind !== "active") {
      setPhase("idle");
      setStatusText(null);
      return;
    }
    session.current = { kind: "idle" };
    setPhase("transcribing");
    setStatusText("转写中…");
    try {
      const clip = await current.recording.stop();
      const run = transcribeRef.current;
      if (!run) {
        throw new Error("转写未接线（缺少转写请求实现）。");
      }
      const text = await run(clip.wav);
      setPhase("idle");
      setStatusText(null);
      onTranscriptRef.current(text);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }, [fail]);

  // 全局手势监听：起手阶段看移动/松手，录音阶段看松手/取消/Escape
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onPointerMove = (event: PointerEvent) => {
      const state = pending.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }
      const distance = Math.hypot(
        event.clientX - state.startX,
        event.clientY - state.startY,
      );
      if (distance > moveTolerancePx) {
        // 拖选：整段起手作废，事件不拦，选区照做
        clearPending();
        setPhase("idle");
        setStatusText(null);
      }
    };
    /** 只认起了手的那根指针：别的指针（或页面上任何无关点击）的松手/取消一律不理会。 */
    const owns = (pointerId: number) => {
      const current = session.current;
      if (current.kind === "idle") {
        return false;
      }
      return current.pointerId === pointerId;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pending.current?.pointerId === event.pointerId) {
        // 未满 200ms 松手 = 普通点击：放行给输入框做光标定位/选区
        clearPending();
        setPhase("idle");
        return;
      }
      if (owns(event.pointerId)) {
        void submit();
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (pending.current?.pointerId === event.pointerId) {
        clearPending();
        setPhase("idle");
        setStatusText(null);
        return;
      }
      if (owns(event.pointerId)) {
        discardSession();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current.kind !== "idle") {
        discardSession();
        return;
      }
      if (event.key === "Escape" && pending.current) {
        clearPending();
        setPhase("idle");
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearPending, discardSession, enabled, moveTolerancePx, submit]);

  // 录音中每 250ms 刷一次时长（状态条「录音中 0:03」）；到上限自动停并提交
  useEffect(() => {
    if (phase !== "recording") {
      return;
    }
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= maxClipMs && session.current.kind === "active") {
        void submit();
      }
    }, 250);
    return () => clearInterval(tick);
  }, [maxClipMs, phase, submit]);

  // 卸载时别让麦克风一直开着
  useEffect(() => {
    return () => {
      const current = session.current;
      if (current.kind === "active") {
        current.recording.discard();
      } else if (current.kind === "starting") {
        current.aborted = true;
      }
      session.current = { kind: "idle" };
      clearPending();
    };
  }, [clearPending]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || phase === "transcribing") {
        return;
      }
      const target = event.target as HTMLElement | null;
      // 工具行按钮 / 下拉 / 隐藏文件输入框：放行，绝不录音
      if (target?.closest?.(INTERACTIVE_SELECTOR)) {
        return;
      }
      // 只认主键（鼠标左键 / 触摸 / 笔）
      if (event.button !== 0) {
        return;
      }
      if (pending.current || session.current.kind !== "idle") {
        return;
      }
      const element = event.currentTarget;
      const { pointerId, clientX, clientY } = event;
      const timer = setTimeout(() => {
        if (pending.current?.pointerId !== pointerId) {
          return;
        }
        try {
          // 捕获指针：手指/鼠标移出输入框后仍能收到松手，不会漏掉提交
          element.setPointerCapture?.(pointerId);
        } catch {
          // 捕获失败不影响：window 上的 pointerup 仍会到
        }
        void beginRecording(pointerId);
      }, holdMs);
      pending.current = {
        timer,
        pointerId,
        startX: clientX,
        startY: clientY,
        element,
      };
      setPhase("arming");
      setStatusText(null);
    },
    [beginRecording, enabled, holdMs, phase],
  );

  const dismissError = useCallback(() => {
    setPhase("idle");
    setStatusText(null);
  }, []);

  const displayStatus = useMemo(() => {
    if (phase === "recording") {
      const seconds = Math.floor(elapsedMs / 1000);
      return `录音中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    return statusText;
  }, [elapsedMs, phase, statusText]);

  return {
    phase,
    statusText: displayStatus,
    lockSelection: phase === "recording",
    onPointerDown,
    dismissError,
  };
}
