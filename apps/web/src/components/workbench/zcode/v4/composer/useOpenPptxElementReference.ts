import { useCallback } from "react";
import { toast } from "@zui/components/ui/toast.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@zui/lib/codeViewer.js";
import type { PptxElementReference } from "@zui/lib/pptxElementReference.js";
import { createPptxElementReferencePreviewSource } from "@zui/lib/pptxElementReferencePreview.js";

export function useOpenPptxElementReference(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { workspacePath, workspaceIdentity, remoteSessionId, onOpenCodeViewer } = options;
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
