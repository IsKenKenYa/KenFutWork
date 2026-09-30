/**
 * zcode 照搬：`@/lib/pptxElementReferencePreview.ts`（references/zcode/packages/ui/src/lib/pptxElementReferencePreview.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */
import type {
  PptxCodeViewerSource,
  PptxReferencePreviewNavigation,
} from "@zui/lib/codeViewer";
import {
  isPptxElementReferenceInWorkspaceScope,
  type PptxElementReference,
} from "@zui/lib/pptxElementReference";
import { isWorkspaceFilePathInside } from "@zui/workspace-file-tree/model";

interface PptxElementReferencePreviewScope {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | undefined;
}

function createPptxReferencePreviewNavigation(
  reference: PptxElementReference,
): PptxReferencePreviewNavigation {
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pptx-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    requestId,
    pageIndex: reference.slideIndex,
    expectedSourceFingerprint: reference.sourceFingerprint,
  };
}

export function createPptxElementReferencePreviewSource(
  reference: PptxElementReference,
  scope: PptxElementReferencePreviewScope,
): PptxCodeViewerSource | null {
  if (
    !isPptxElementReferenceInWorkspaceScope(reference, scope) ||
    !isWorkspaceFilePathInside(reference.workspacePath, reference.sourcePath)
  ) {
    return null;
  }

  return {
    type: "pptx",
    title: reference.sourceTitle,
    path: reference.sourcePath,
    workspacePath: reference.workspacePath,
    ...(reference.workspaceIdentity
      ? { workspaceIdentity: reference.workspaceIdentity }
      : {}),
    ...(reference.remoteSessionId
      ? { workspaceRemoteSessionId: reference.remoteSessionId }
      : {}),
    referenceNavigation: createPptxReferencePreviewNavigation(reference),
  };
}
