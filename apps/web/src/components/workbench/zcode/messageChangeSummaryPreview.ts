/**
 * zcode 照搬：`@/messageChangeSummaryPreview.ts`（references/zcode/packages/ui/src/messageChangeSummaryPreview.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import type { CodeViewerWorkspaceScope } from "@zui/lib/codeViewerWorkspaceScope";

export function buildChangeSummaryFilePreviewSource(
  input: {
    path: string;
    relativePath: string;
    workspacePath: string;
  } & CodeViewerWorkspaceScope,
): CodeViewerSource {
  const {
    path,
    relativePath,
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  } = input;
  return {
    type: "file",
    title: relativePath,
    path,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
}
