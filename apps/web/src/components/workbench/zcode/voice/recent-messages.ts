"use client";

/**
 * Code 转录 → 「想」段的指代消解上下文（规划 §2.3）。
 *
 * 只取**真实用户输入**与**已完成的助手正文**：工具行、思考行、子代理行不是会话内容
 * （塞进去只会污染改写）。与 Design 侧共用 `buildRefineContext` 的截断口径。
 */

import type { VoiceRefineContextMessage } from "@kenfutwork/voice-ui";
import { buildRefineContext } from "@kenfutwork/voice-ui";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export function recentMessagesFromSnapshot(
  snapshot: ConversationSnapshot | null,
): VoiceRefineContextMessage[] {
  if (!snapshot) {
    return [];
  }
  return buildRefineContext(
    snapshot.rows.window.flatMap(
      (row): Array<{ role: "user" | "assistant"; text: string }> => {
        if (row.kind === "userInput" && row.origin === "realUser") {
          return [{ role: "user", text: row.text }];
        }
        if (row.kind === "assistantText" && row.state === "complete") {
          return [{ role: "assistant", text: row.text }];
        }
        return [];
      },
    ),
  );
}
