"use client";

import type {
  VoiceMode,
  VoiceRefineContextMessage,
  VoiceSettings,
} from "@kenfutwork/shared";
import {
  type ComposerVoiceBinding,
  type ComposerVoiceOptions as CoreComposerVoiceOptions,
  useComposerVoice as useCoreComposerVoice,
} from "@kenfutwork/voice-ui";
import { useCallback, useEffect, useState } from "react";

import { dedupeRequest } from "@/lib/dedupe-request";
import {
  fetchVoiceSettings,
  refineVoice,
  transcribeVoice,
} from "@/lib/server-api";

/**
 * Design 侧（画布助手）的语音接线适配层。
 *
 * 手势、状态行与方案 A/B 的核心编排已下沉 `@kenfutwork/voice-ui`
 * （Code 模式的 ZCode 输入框共用同一份口径）；本文件只负责两件事：
 * 1. 注入 web 侧 transport（`/api/voice/*` + accessToken）；
 * 2. 读功能模式（`useVoiceMode`）与广播设置变更事件（供同页输入框换档）。
 */

/** 设置页保存成功后广播的事件名（同页输入框据此换档）。 */
export const VOICE_SETTINGS_CHANGED_EVENT = "kenfutwork:voice-settings-changed";

export type { ComposerVoiceBinding };

export interface ComposerVoiceOptions
  extends Omit<CoreComposerVoiceOptions, "transcribe" | "refine"> {
  /** 无 token（未登录/纯本地演示态）：请求靠 cookie 或按失败处理，接线逻辑不变。 */
  accessToken: string | null | undefined;
  /** 注入：转写请求（测试用；默认打 `POST /api/voice/transcribe`）。 */
  transcribe?: (wav: Uint8Array) => Promise<string>;
  /** 注入：需求改写（测试用；默认打 `POST /api/voice/refine`）。 */
  refine?: (input: {
    text: string;
    recentMessages?: VoiceRefineContextMessage[];
  }) => Promise<string>;
}

export function useComposerVoice(
  options: ComposerVoiceOptions,
): ComposerVoiceBinding {
  const { accessToken, transcribe, refine, ...coreOptions } = options;

  const runTranscribe = useCallback(
    (wav: Uint8Array) =>
      transcribe ? transcribe(wav) : transcribeVoice(accessToken, wav),
    [accessToken, transcribe],
  );

  const runRefine = useCallback(
    (input: { text: string; recentMessages?: VoiceRefineContextMessage[] }) =>
      refine ? refine(input) : refineVoice(accessToken, input),
    [accessToken, refine],
  );

  return useCoreComposerVoice({
    ...coreOptions,
    transcribe: runTranscribe,
    refine: runRefine,
  });
}

/** 读不到设置时的默认档：与契约默认一致（只转文本 / 不朗读）。 */
const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  mode: "transcribe",
  listen: null,
  think: null,
  speak: null,
  speakReplies: false,
};

/**
 * 读完整语音设置（功能模式 + 朗读开关）。输入框与消息区（播报）共用一份。
 *
 * 读不到就按**默认档**处理：这是规划 §4.1 的默认，也是更保守的一侧
 * ——宁可不自动执行/不朗读，也不要因为一次读失败就去替用户起 run 或出声。
 */
export function useVoiceSettings(
  accessToken: string | null | undefined,
): VoiceSettings {
  const [settings, setSettings] = useState<VoiceSettings>(
    DEFAULT_VOICE_SETTINGS,
  );
  // 设置页保存后广播：同页输入框与播报立刻换档，不必重载页面
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<VoiceSettings>).detail;
      if (detail) {
        setSettings(detail);
      }
    };
    window.addEventListener(VOICE_SETTINGS_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(VOICE_SETTINGS_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void dedupeRequest(`voice-settings:${accessToken ?? "local"}`, () =>
      fetchVoiceSettings(accessToken),
    )
      .then((response) => {
        // 响应形状不含 settings（老服务端 / 中间层塞了别的 JSON）时保持默认档：
        // 把 undefined 设进 state 会让 `useVoiceMode` 在渲染期读 `.mode` 直接崩掉整棵输入区。
        if (!cancelled && response.settings) {
          setSettings(response.settings);
        }
      })
      .catch(() => {
        // 读不到设置不该弹出报错（用户没主动做什么）：按默认档处理即可
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);
  return settings;
}

/** 只读功能模式（方案 A / B）：`useVoiceSettings` 的窄面。 */
export function useVoiceMode(
  accessToken: string | null | undefined,
): VoiceMode {
  return useVoiceSettings(accessToken).mode;
}
