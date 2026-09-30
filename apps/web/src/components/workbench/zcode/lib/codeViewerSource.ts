/**
 * zcode 照搬：`@/lib/codeViewerSource.ts`（references/zcode/packages/ui/src/lib/codeViewerSource.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import { decodeFilePathUriEscapes, getPathLeaf } from "@zui/lib/path";

export function normalizeCodeViewerSource(
  source: CodeViewerSource,
): CodeViewerSource {
  const decodedTitle = decodeFilePathUriEscapes(source.title);

  if (!("path" in source) || !source.path) {
    return decodedTitle === source.title
      ? source
      : { ...source, title: decodedTitle };
  }

  const decodedPath = decodeFilePathUriEscapes(source.path);
  const sourceLeaf = getPathLeaf(source.path);
  const decodedLeaf = getPathLeaf(decodedPath);
  const title =
    source.title === sourceLeaf || source.title.trim().length === 0
      ? decodedLeaf
      : decodedTitle;

  if (decodedPath === source.path && title === source.title) {
    return source;
  }

  return {
    ...source,
    title,
    path: decodedPath,
  };
}
