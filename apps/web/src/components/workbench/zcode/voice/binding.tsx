"use client";

import type {
  VoiceRefineContextMessage,
  VoiceSettings,
} from "@kenfutwork/shared";
import {
  type ComposerVoiceBinding,
  createVoicePlayback,
  extractSpeakableText,
  useComposerVoice,
  type VoiceRecorder,
} from "@kenfutwork/voice-ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Code 模式（ZCode 界面）输入框的语音桥（宿主自写，不进 ZCode 源码清单）。
 *
 * 与 Design 侧共用 `@kenfutwork/voice-ui` 的核心编排：按住输入卡说话 → 转写 →
 * 填入输入框（只转文本档）；完整回路档走「改写 → 2 秒撤销窗口 → 自动提交」；
 * 「朗读回复」打开时，回复完成由 composer 调 `speakReply` 念出来。
 * 这里只做三件事：
 * 1. 宿主（`host/main.tsx`）注入 Code 侧 transport——转写是 multipart、播报是二进制、
 *    其余走 iframe 自己的 HTTP 通道（cookie 认证，见 `CodeHttpChannelClient`）；
 * 2. 挂载时读一次语音设置拿功能模式与朗读开关；窗口重新聚焦时刷新（设置面板在父窗口，
 *    iframe 收不到它的 window 事件，聚焦回来对齐一次就够）；
 * 3. 维持一个播报实例（打断口径与 Design 侧同一份）。
 */

export interface CodeVoiceTransport {
  transcribe: (wav: Uint8Array) => Promise<string>;
  refine: (input: {
    text: string;
    recentMessages?: VoiceRefineContextMessage[];
  }) => Promise<string>;
  speak: (input: { text: string; signal: AbortSignal }) => Promise<Blob>;
  fetchSettings: () => Promise<VoiceSettings>;
}

const CodeVoiceContext = createContext<CodeVoiceTransport | null>(null);

export function CodeVoiceProvider({
  transport,
  children,
}: {
  transport: CodeVoiceTransport;
  children: ReactNode;
}) {
  return (
    <CodeVoiceContext.Provider value={transport}>
      {children}
    </CodeVoiceContext.Provider>
  );
}

/** 没注入 transport 时的占位：不会被触发（无 transport 时接线侧直接返回 null）。 */
const UNWIRED_TRANSPORT: CodeVoiceTransport = {
  transcribe: () =>
    Promise.reject(new Error("语音未接线（缺少 CodeVoiceProvider）。")),
  refine: () =>
    Promise.reject(new Error("语音未接线（缺少 CodeVoiceProvider）。")),
  speak: () =>
    Promise.reject(new Error("语音未接线（缺少 CodeVoiceProvider）。")),
  fetchSettings: () =>
    Promise.reject(new Error("语音未接线（缺少 CodeVoiceProvider）。")),
};

/** 读不到设置按默认档（只转文本 / 不朗读）——宁可不自动执行/不出声，也不要猜。 */
const DEFAULT_SETTINGS: VoiceSettings = {
  mode: "transcribe",
  listen: null,
  think: null,
  speak: null,
  speakReplies: false,
};

function useCodeVoiceSettings(transport: CodeVoiceTransport | null): {
  settings: VoiceSettings;
  settingsRef: React.RefObject<VoiceSettings>;
} {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    const load = () => {
      void transport
        .fetchSettings()
        .then((next) => {
          if (!cancelled) setSettings(next);
        })
        .catch(() => {
          // 读不到不报错（用户没主动做什么）：按默认档处理即可
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [transport]);
  return { settings, settingsRef };
}

export interface CodeComposerVoiceOptions {
  /** false = 完全不接线（输入框禁用/拒绝档时不起录音）。 */
  enabled?: boolean;
  onTranscript: (text: string) => void;
  onAutoSubmit?: (prompt: string) => void;
  /** 「想」段的指代消解上下文：最近几条转录消息（由 composer 从投影提取）。 */
  recentMessages?: VoiceRefineContextMessage[];
  undoWindowMs?: number;
  /** 注入：录音器（测试用；默认浏览器实现）。 */
  recorder?: VoiceRecorder;
}

export interface CodeComposerVoiceBinding extends ComposerVoiceBinding {
  /**
   * 念一段助手回复（完整回路 + 朗读开关打开时才念；打断旧播报）。
   * 调用方只在「回复刚刚完成」时调——历史消息不在此列。
   */
  speakReply: (text: string) => void;
  /** 立刻停掉播报（切会话/卸载等）。 */
  stopSpeaking: () => void;
}

/**
 * Code 输入框的语音接线。无 Provider（如独立挂载的组件测试）时不接线返回 null，
 * composer 行为与从前一致。
 */
export function useCodeComposerVoice(
  options: CodeComposerVoiceOptions,
): CodeComposerVoiceBinding | null {
  const transport = useContext(CodeVoiceContext);
  const { settings, settingsRef } = useCodeVoiceSettings(transport);
  const {
    enabled = true,
    onTranscript,
    onAutoSubmit,
    undoWindowMs,
    recorder,
  } = options;
  const active = transport ?? UNWIRED_TRANSPORT;
  const playback = useMemo(
    () =>
      createVoicePlayback({
        transport: { speak: (input) => active.speak(input) },
      }),
    [active],
  );
  // 组件卸载/换 transport 即停播：播报不该跟过页面生命周期
  useEffect(() => () => playback.stop(), [playback]);

  const stopSpeaking = useCallback(() => playback.stop(), [playback]);
  const speakReply = useCallback(
    (text: string) => {
      const current = settingsRef.current;
      // 只转文本档不播报：朗读开关本就只在完整回路档出现（与设置页同一口径）
      if (current.mode !== "loop" || !current.speakReplies) {
        return;
      }
      const speakable = extractSpeakableText(text);
      if (!speakable) {
        return;
      }
      // 播报失败不打扰（正文已在屏幕上）
      void playback.speak(speakable).catch(() => undefined);
    },
    [playback, settingsRef],
  );

  const binding = useComposerVoice({
    mode: settings.mode,
    onTranscript,
    ...(onAutoSubmit ? { onAutoSubmit } : {}),
    ...(options.recentMessages
      ? { recentMessages: options.recentMessages }
      : {}),
    // 用户开始说话：正在念的回复立刻让位
    onRecordingStart: stopSpeaking,
    ...(undoWindowMs !== undefined ? { undoWindowMs } : {}),
    ...(recorder ? { recorder } : {}),
    transcribe: active.transcribe,
    refine: active.refine,
  });
  if (!transport || !enabled) {
    return null;
  }
  return { ...binding, speakReply, stopSpeaking };
}
