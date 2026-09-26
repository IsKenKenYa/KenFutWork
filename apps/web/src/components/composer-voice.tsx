"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeVoice } from "@/lib/server-api";
import { useHoldToTalk } from "@/lib/use-hold-to-talk";
import type { VoiceRecorder } from "@/lib/voice-audio";

/**
 * 输入框语音接线（三处共用：追问 / 空态 / Design 画布助手）。
 *
 * 三个输入框的交互必须完全一致，故手势、状态行、「没听到语音」的判定都收在这里，
 * 各输入框只负责把 `onTranscript` 接进自己的受控 state 写入路径（受控写入见
 * `lib/composer-edit.ts`：绕开它会让画布助手的自管撤销历史与 React state 脱钩）。
 *
 * 文案按《AGENTS.md》「界面文案只写给用户看」：一句说清，不写实现细节。
 */

export interface ComposerVoiceOptions {
  /** 无 token（未登录/纯本地演示态）时不接线：手势退化为普通点击。 */
  accessToken: string | undefined;
  /** 拿到文本（**保证非空**；空结果由本层消化成提示）。 */
  onTranscript: (text: string) => void;
  /** 注入：录音器（测试用；默认浏览器实现）。 */
  recorder?: VoiceRecorder;
  /** 注入：转写请求（测试用；默认打 `POST /api/voice/transcribe`）。 */
  transcribe?: (wav: Uint8Array) => Promise<string>;
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

export function useComposerVoice({
  accessToken,
  onTranscript,
  recorder,
  transcribe,
}: ComposerVoiceOptions): ComposerVoiceBinding {
  const [notice, setNotice] = useState<string | null>(null);
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
      onTranscript(trimmed);
    },
    [onTranscript, showNotice],
  );

  const voice = useHoldToTalk({
    enabled: Boolean(accessToken),
    onTranscript: handleTranscript,
    onError: showNotice,
    transcribe: runTranscribe,
    ...(recorder ? { recorder } : {}),
  });

  const status =
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

  return {
    onPointerDown: voice.onPointerDown,
    lockSelection: voice.lockSelection,
    status: notice ? (
      <p role="status" className="mt-1 text-xs text-muted-foreground">
        {notice}
      </p>
    ) : (
      status
    ),
  };
}
