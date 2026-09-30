/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/EditInlineDiffContent.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/EditInlineDiffContent.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 * 适配注记：接口可选属性放宽 | undefined 以等价 zcode tsconfig 行为（exactOptionalPropertyTypes）。
 */

import {
  buildHighlightedLightweightDiffCode,
  getHighlightedLightweightDiffLine,
  HighlightedLightweightDiffPreview,
} from "@zui/components/ui/highlighted-lightweight-diff-preview";
import type { CodePreviewSettings } from "@zui/lib/codePreviewSettings";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zui/lib/codePreviewSettings";
import {
  inferCodeLanguage,
  type PatchCodeViewerSource,
} from "@zui/lib/codeViewer";
import { getPlainTextPatchPreviewLines } from "@zui/lib/patchDiffPreview";
import type { Theme } from "@zui/useTheme";
import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";

export {
  buildHighlightedLightweightDiffCode as buildInlineDiffHighlightCode,
  getHighlightedLightweightDiffLine as getInlineDiffHighlightLine,
};

function resolveInlineDiffHighlightTheme(
  theme: Theme | undefined,
  codePreviewSettings: CodePreviewSettings,
): BundledTheme {
  if (theme === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? codePreviewSettings.darkTheme
        : codePreviewSettings.lightTheme;
    }

    return codePreviewSettings.lightTheme;
  }

  return theme === "dark" || theme === "zai-dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

export const EditInlineDiffContent = memo(function EditInlineDiffContent({
  preview,
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
}: {
  preview: PatchCodeViewerSource;
  /**
   * 应用主题（store 耦合剥离）：决定 diff 高亮取 light/dark 主题。
   * 由调用方（tool call 渲染上下文）传入；默认 "system" 跟随操作系统兜底。
   */
  theme?: Theme | undefined;
  /** 代码预览设置（store 耦合剥离）：由调用方传入，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings | undefined;
}) {
  const previewLines = useMemo(
    () => getPlainTextPatchPreviewLines(preview.patch),
    [preview.patch],
  );
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(preview.path ?? preview.title, preview.patch),
    [preview.patch, preview.path, preview.title],
  );
  const highlightTheme = useMemo(
    () => resolveInlineDiffHighlightTheme(theme, codePreviewSettings),
    [codePreviewSettings, theme],
  );

  return (
    <div className="space-y-3">
      <div
        className="mb-2 max-h-60 overflow-auto rounded-xl border border-border bg-card"
        data-inline-diff-preview
      >
        {/* 聊天内联 diff 展开时直接挂载 @pierre/diffs 会把高亮和 Shadow DOM 汇总渲染压到主线程，
        导致点击展开后长时间掉帧。这里首帧只渲染轻量 hunk 文本，再在 effect 里异步补 Shiki token；
        之前只保留纯文本会让 session 里的 diff 永久失去语法高亮。 */}
        <HighlightedLightweightDiffPreview
          className="h-full bg-card"
          codePreviewSettings={codePreviewSettings}
          data-inline-diff-highlight-language={highlightLanguage}
          data-inline-diff-highlight-theme={highlightTheme}
          language={highlightLanguage}
          lines={previewLines}
          path={preview.path ?? preview.title}
          theme={highlightTheme}
        />
      </div>
    </div>
  );
});
EditInlineDiffContent.displayName = "EditInlineDiffContent";
