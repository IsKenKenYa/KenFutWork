"use client";

/**
 * 「想」段改写请求的会话上下文（规划 §2.3：转写文本 + 最近 N 条会话消息）。
 *
 * 指代消解（「刚才那个按钮」）只需要最近几条的**文字大意**，不是整段转录：
 * 单条截断、条数封顶（与契约的 `VOICE_REFINE_CONTEXT_LIMIT` 一致），
 * 两边宿主（Design 消息区 / Code 转录）用同一份口径，避免一边塞整段一边截半句。
 */

import {
  VOICE_REFINE_CONTEXT_LIMIT,
  type VoiceRefineContextMessage,
} from "@kenfutwork/shared";

export type { VoiceRefineContextMessage };

/** 单条上下文的消息上限（字符）：够消解指代，又不把整篇回复塞进请求。 */
export const VOICE_REFINE_CONTEXT_MESSAGE_CHARS = 500;

export function buildRefineContext(
  entries: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): VoiceRefineContextMessage[] {
  return entries
    .flatMap((entry) => {
      const content = entry.text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, VOICE_REFINE_CONTEXT_MESSAGE_CHARS);
      if (!content) {
        return [];
      }
      return [{ role: entry.role, content }];
    })
    .slice(-VOICE_REFINE_CONTEXT_LIMIT);
}
