/**
 * 统一的「下载这个文件」入口：桌面形态落**系统下载目录**并在文件管理器里定位
 * （macOS 壳的 WKWebView 不认 `<a download>`，锚点点了毫无反应，见 `lib/desktop-system.ts`）；
 * 浏览器形态维持对象 URL + 锚点下载。所有下载按钮一律走这里，不再各自内联锚点逻辑。
 */

import { isDesktopShell } from "./desktop-embed";
import { revealPath, saveFileToDownloads } from "./desktop-system";

export async function triggerDownload(name: string, blob: Blob): Promise<void> {
  if (isDesktopShell()) {
    try {
      const path = await saveFileToDownloads(name, await blob.arrayBuffer());
      if (path) {
        await revealPath(path);
        return;
      }
    } catch (error) {
      // 落盘失败别静默：退回浏览器锚点（Windows 的 WebView2 认 `<a download>`，
      // 比直接失败强）；macOS 上这条路本来就失灵，错误已在控制台可见。
      console.error("[download] 桌面落盘失败，退回浏览器下载", error);
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
