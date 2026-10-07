import { lazy, Suspense } from "react";
import type { PptxPreviewViewerLabels } from "@zui/components/ui/pptx-preview-viewer.js";
import type { PptxElementReferenceSource } from "@zui/lib/pptxElementReference.js";
import type { PptxReferencePreviewNavigation } from "@zui/lib/codeViewer.js";

const PptxPreviewViewer = lazy(() =>
  import("@zui/components/ui/pptx-preview-viewer.js").then((module) => ({
    default: module.PptxPreviewViewer,
  })),
);

export function PptxPreviewContent({
  data,
  fileName,
  labels,
  onOpenBrowserUrl,
  referenceSource,
  referenceNavigation,
  referenceNavigationReady,
}: {
  data: ArrayBuffer;
  labels: PptxPreviewViewerLabels;
  fileName?: string;
  referenceSource?: PptxElementReferenceSource;
  referenceNavigation?: PptxReferencePreviewNavigation;
  referenceNavigationReady?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PptxPreviewViewer
        data={data}
        fileName={fileName}
        labels={labels}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(referenceSource ? { referenceSource } : {})}
        {...(referenceNavigation ? { referenceNavigation } : {})}
        referenceNavigationReady={referenceNavigationReady}
        className="h-full"
      />
    </Suspense>
  );
}
