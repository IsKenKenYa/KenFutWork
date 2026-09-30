/**
 * zcode 照搬：`@/v4/composer/useOpenPptxElementReference.ts`（references/zcode/packages/ui/src/v4/composer/useOpenPptxElementReference.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { toast } from "@zui/components/ui/toast";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import type { PptxElementReference } from "@zui/lib/pptxElementReference";
import { createPptxElementReferencePreviewSource } from "@zui/lib/pptxElementReferencePreview";
import { useCallback } from "react";

export function useOpenPptxElementReference(options: {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | undefined;
  onOpenCodeViewer?: ((source: CodeViewerSource) => void) | undefined;
}) {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  } = options;
  const { intl } = useZCodeIntl();

  return useCallback(
    (reference: PptxElementReference) => {
      if (!onOpenCodeViewer) {
        return;
      }
      const source = createPptxElementReferencePreviewSource(reference, {
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
      });
      if (!source) {
        toast(
          intl.formatMessage({
            id: "chat.pptxElements.previewScopeUnavailable",
          }),
        );
        return;
      }
      onOpenCodeViewer(source);
    },
    [intl, onOpenCodeViewer, remoteSessionId, workspaceIdentity, workspacePath],
  );
}
