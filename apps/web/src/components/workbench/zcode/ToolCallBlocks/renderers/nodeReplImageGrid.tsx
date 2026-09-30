/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/nodeReplImageGrid.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/nodeReplImageGrid.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { ImagePreviewDialog } from "@zui/components/ai-elements/image-preview-dialog";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@zui/components/ai-elements/image-thumbnail-gallery";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { NodeReplDisplayModel } from "@zui/lib/nodeReplToolDisplay";
import { useMemo, useRef, useState } from "react";

export function NodeReplImageGrid({
  images,
  resultImageLabel,
}: {
  images: ReadonlyArray<NodeReplDisplayModel["images"][number]>;
  resultImageLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previewItems = useMemo(
    () =>
      images.map((image, index) => ({
        alt: `${resultImageLabel} ${index + 1}`,
        filename: `result-image-${index + 1}`,
        src: `data:${image.mimeType};base64,${image.base64}`,
      })),
    [images, resultImageLabel],
  );
  const openImageLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });

  const handleOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      window.setTimeout(() => triggerRefs.current[previewIndex]?.focus(), 0);
    }
  };

  return (
    <>
      <ImageThumbnailGallery
        data-node-repl-image-gallery=""
        grouped={previewItems.length >= 2}
      >
        {previewItems.map((item, index) => (
          <button
            ref={(node) => {
              triggerRefs.current[index] = node;
            }}
            type="button"
            aria-label={`${openImageLabel} ${index + 1}`}
            className={imageThumbnailTriggerClassName}
            data-image-thumbnail-trigger=""
            key={`${images[index]?.mimeType}:${images[index]?.base64.length}:${index}`}
            onClick={() => {
              setPreviewIndex(index);
              setPreviewOpen(true);
            }}
          >
            <img
              alt={item.alt}
              className={imageThumbnailClassName}
              draggable={false}
              loading="lazy"
              src={item.src}
            />
          </button>
        ))}
      </ImageThumbnailGallery>
      <ImagePreviewDialog
        dialogTestId="node-repl-image-lightbox"
        imageTestId="node-repl-image-lightbox-image"
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handleOpenChange}
        open={previewOpen}
      />
    </>
  );
}
