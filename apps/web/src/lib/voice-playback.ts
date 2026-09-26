"use client";

/**
 * 语音播报（规划 §4.2 的「说」段 + §7 的「语音回复开关」）。
 *
 * 打断是这里的核心：**新的一次播报、用户下一次说话、或切走项目，都必须立刻停掉
 * 上一句**——播报叠着播是语音交互里最刺耳的失败形态。
 *
 * 实现用 `<audio>` + object URL 而不是 Web Audio：前者自带播放/时长/结束事件，
 * 而且 `pause()` + `src=""` 就够打断；Web Audio 要自己管 buffer 与生命周期，
 * 为「念一句话」不划算。
 */

import { getServerBaseUrl } from "./env";

export interface VoicePlayback {
  /** 念一段文本；返回是否念完（被新的播报/打断取代时为 false）。 */
  speak(accessToken: string, text: string): Promise<boolean>;
  /** 立刻停掉当前播报（含在途请求）。 */
  stop(): void;
  /** 是否正在播。 */
  isSpeaking(): boolean;
}

interface VoicePlaybackDeps {
  /** 测试注入：音频元素工厂（jsdom 不实现真正的播放）。 */
  createAudio?: () => HTMLAudioElement;
  fetchFn?: typeof fetch;
}

/** 播报长度上限：回复很长时只念开头，别让用户等一分钟的朗读。 */
const MAX_SPEAK_CHARS = 500;

export function createVoicePlayback(
  deps: VoicePlaybackDeps = {},
): VoicePlayback {
  const doFetch = deps.fetchFn ?? fetch;
  const createAudio = deps.createAudio ?? (() => new Audio());
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let controller: AbortController | null = null;
  /** 每次播报一个代号：旧播报发现代号变了就自己退出，不覆盖新的。 */
  let generation = 0;
  /**
   * 在途播报的收尾回调。**必须存着**：打断时要把它以 false 收尾，
   * 否则 `await speak(...)` 的调用方会永远挂着（实测就是这么漏的）。
   */
  let finishCurrent: ((done: boolean) => void) | null = null;

  function cleanup() {
    if (audio) {
      audio.pause();
      audio.src = "";
      audio = null;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
    controller?.abort();
    controller = null;
    finishCurrent?.(false);
    finishCurrent = null;
  }

  return {
    isSpeaking: () => audio !== null,

    stop() {
      // 代号先走：在途请求回来时看到代号变了就不会再开播
      generation += 1;
      cleanup();
    },

    async speak(accessToken, text) {
      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }
      // 打断上一句：新播报优先
      this.stop();
      const mine = ++generation;
      controller = new AbortController();
      const response = await doFetch(`${getServerBaseUrl()}/api/voice/speak`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: trimmed.slice(0, MAX_SPEAK_CHARS) }),
        signal: controller.signal,
      }).catch((error: unknown) => {
        // 被自己打断：不算失败（新播报已经接上）
        if (mine !== generation) {
          return null;
        }
        throw error;
      });
      if (response === null || mine !== generation) {
        return false;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? "播报失败。");
      }
      const blob = await response.blob();
      if (mine !== generation) {
        return false;
      }
      url = URL.createObjectURL(blob);
      const element = createAudio();
      element.src = url;
      audio = element;
      return await new Promise<boolean>((resolve) => {
        finishCurrent = resolve;
        element.onended = () => {
          if (mine === generation) {
            finishCurrent = null;
            cleanup();
          }
          resolve(true);
        };
        element.onerror = () => {
          if (mine === generation) {
            finishCurrent = null;
            cleanup();
          }
          resolve(false);
        };
        void element.play?.().catch(() => {
          // 浏览器可能因「用户还没交互过」拒绝自动播放：静默放弃播报，
          // 不弹错误（正文还在屏幕上，没念出来不影响用）
          if (mine === generation) {
            finishCurrent = null;
            cleanup();
          }
          resolve(false);
        });
      });
    },
  };
}

/**
 * 从一段助手回复里取出**该念的部分**：去掉 Markdown 记号与代码块。
 * 念代码是最没有意义的播报（还会把 `{}` 念成一串符号），故整块剔掉。
 */
export function extractSpeakableText(markdown: string, limit = 500): string {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\*\*|__|\*|_|~~/g, "");
  const collapsed = withoutCode.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}
