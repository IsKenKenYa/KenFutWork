"use client";

import type {
  VoiceMode,
  VoiceRefineContextMessage,
  VoiceSettings,
} from "@kenfutwork/shared";
import {
  type ComposerVoiceBinding,
  useComposerVoice,
  type VoiceRecorder,
} from "@kenfutwork/voice-ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Code 模式（ZCode 界面）输入框的语音桥（宿主自写，不进 ZCode 源码清单）。
 *
 * 与 Design 侧共用 `@kenfutwork/voice-ui` 的核心编排：按住输入卡说话 → 转写 →
 * 填入输入框（只转文本档）；完整回路档走「改写 → 2 秒撤销窗口 → 自动提交」。
 * 这里只做两件事：
 * 1. 宿主（`host/main.tsx`）注入 Code 侧 transport——转写是 multipart、其余走
 *    iframe 自己的 HTTP 通道（cookie 认证，见 `CodeHttpChannelClient`）；
 * 2. 挂载时读一次语音设置拿功能模式；窗口重新聚焦时刷新（设置面板在父窗口，
 *    iframe 收不到它的 window 事件，聚焦回来对齐一次就够）。
 *
 * 指代消解用的 `recentMessages` 不接：Design 侧同款口径也尚未喂数据，留后续。
 */

export interface CodeVoiceTransport {
  transcribe: (wav: Uint8Array) => Promise<string>;
  refine: (input: {
    text: string;
    recentMessages?: VoiceRefineContextMessage[];
  }) => Promise<string>;
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
  fetchSettings: () =>
    Promise.reject(new Error("语音未接线（缺少 CodeVoiceProvider）。")),
};

/** 功能模式：读不到按默认档（只转文本）——宁可不自动执行，也不要因一次读失败替用户起任务。 */
function useCodeVoiceMode(transport: CodeVoiceTransport | null): VoiceMode {
  const [mode, setMode] = useState<VoiceMode>("transcribe");
  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    const load = () => {
      void transport
        .fetchSettings()
        .then((settings) => {
          if (!cancelled) setMode(settings.mode);
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
  return mode;
}

export interface CodeComposerVoiceOptions {
  /** false = 完全不接线（输入框禁用/拒绝档时不起录音）。 */
  enabled?: boolean;
  onTranscript: (text: string) => void;
  onAutoSubmit?: (prompt: string) => void;
  undoWindowMs?: number;
  /** 注入：录音器（测试用；默认浏览器实现）。 */
  recorder?: VoiceRecorder;
}

/**
 * Code 输入框的语音接线。无 Provider（如独立挂载的组件测试）时不接线返回 null，
 * composer 行为与从前一致。
 */
export function useCodeComposerVoice(
  options: CodeComposerVoiceOptions,
): ComposerVoiceBinding | null {
  const transport = useContext(CodeVoiceContext);
  const mode = useCodeVoiceMode(transport);
  const { enabled = true, onTranscript, onAutoSubmit, undoWindowMs, recorder } =
    options;
  const active = transport ?? UNWIRED_TRANSPORT;
  const binding = useComposerVoice({
    mode,
    onTranscript,
    ...(onAutoSubmit ? { onAutoSubmit } : {}),
    ...(undoWindowMs !== undefined ? { undoWindowMs } : {}),
    ...(recorder ? { recorder } : {}),
    transcribe: active.transcribe,
    refine: active.refine,
  });
  return transport && enabled ? binding : null;
}
