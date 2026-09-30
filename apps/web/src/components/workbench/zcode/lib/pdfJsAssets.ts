/**
 * zcode 照搬：`@/lib/pdfJsAssets.ts`（references/zcode/packages/ui/src/lib/pdfJsAssets.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
interface PdfJsDocumentOptions {
  cMapPacked: true;
  cMapUrl: string;
}

export function createPdfJsDocumentOptions(
  viteBaseUrl: string,
  documentUrl: string,
): PdfJsDocumentOptions {
  const applicationBaseUrl = new URL(viteBaseUrl, documentUrl);
  return {
    cMapPacked: true,
    cMapUrl: new URL("pdfjs/cmaps/", applicationBaseUrl).href,
  };
}
