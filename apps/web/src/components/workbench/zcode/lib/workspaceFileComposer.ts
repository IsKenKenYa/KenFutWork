/**
 * zcode 照搬：`@/lib/workspaceFileComposer.ts`（references/zcode/packages/ui/src/lib/workspaceFileComposer.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）。
 */

// LexicalChatInput 壳恢复后回归原始句柄类型（过渡的 ComposerInputHandle 最小面退役）。
import type { LexicalChatInputHandle } from "@zui/LexicalChatInput";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
} from "@zui/lib/workspaceFileDrag";
import type { MutableRefObject } from "react";

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  payload: WorkspaceFileDragPayload;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  onTextChange: (text: string) => void;
}) {
  const mention = createWorkspaceFileComposerMention(
    params.payload,
    params.workspacePath,
    params.workspaceIdentity,
  );
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown)
      ? " "
      : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    params.payload.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}
