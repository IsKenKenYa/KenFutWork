"use client";

/**
 * 播报的 web 适配层（Design 画布助手用）。
 *
 * 播放与打断的核心已下沉 `@kenfutwork/voice-ui`（Code 模式共用同一份口径）；
 * 本文件只负责注入 web 侧的合成请求：`POST /api/voice/speak`（cookie/Bearer）。
 *
 * 打断是核心口径：**新的一次播报、用户下一次说话、或切走项目，都必须立刻停掉
 * 上一句**——播报叠着播是语音交互里最刺耳的失败形态。
 */

import {
  createVoicePlayback as createCorePlayback,
  type VoicePlayback,
} from "@kenfutwork/voice-ui";

import { getServerBaseUrl } from "./env";
import { bearerHeaders, serverFetch } from "./local-access";

export type { VoicePlayback };

interface VoicePlaybackDeps {
  /** 测试注入：音频元素工厂（jsdom 不实现真正的播放）。 */
  createAudio?: () => HTMLAudioElement;
  fetchFn?: typeof fetch;
}

export type WebVoicePlayback = Omit<VoicePlayback, "speak"> & {
  /** 念一段文本（token 供 Bearer；cookie 形态传 null 即可）。 */
  speak(accessToken: string | null | undefined, text: string): Promise<boolean>;
};

export function createVoicePlayback(
  deps: VoicePlaybackDeps = {},
): WebVoicePlayback {
  const doFetch = deps.fetchFn ?? serverFetch;
  // speak(accessToken, text) 的 token 按调用绑定：core 的 transport 不带 token
  let currentToken: string | null | undefined;
  const core = createCorePlayback({
    ...(deps.createAudio ? { createAudio: deps.createAudio } : {}),
    transport: {
      async speak({ text, signal }) {
        const response = await doFetch(
          `${getServerBaseUrl()}/api/voice/speak`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              ...bearerHeaders(currentToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({ text }),
            signal,
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "播报失败。");
        }
        return await response.blob();
      },
    },
  });
  return {
    speak(accessToken, text) {
      currentToken = accessToken;
      return core.speak(text);
    },
    stop: () => core.stop(),
    isSpeaking: () => core.isSpeaking(),
  };
}

/** 页面共享的播报实例：输入框（打断）与消息区（念回复）用同一个。 */
let sharedPlayback: WebVoicePlayback | null = null;

export function getVoicePlayback(): WebVoicePlayback {
  if (!sharedPlayback) {
    sharedPlayback = createVoicePlayback();
  }
  return sharedPlayback;
}

export { extractSpeakableText } from "@kenfutwork/voice-ui";
