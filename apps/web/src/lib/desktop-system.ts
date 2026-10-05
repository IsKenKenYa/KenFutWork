/**
 * 桌面壳的**系统缝**：下载落盘（`save_file`）、文件管理器定位（`reveal_path`）、
 * 外链交给系统浏览器（`open_external`）。Rust 侧实现在
 * `apps/desktop/src-tauri/src/desktop_system.rs`，命令名与参数形状两边必须一致——
 * 对不上时前端只会在桌面形态下静默失效。
 *
 * 为什么需要：macOS 壳的内核是 WKWebView——`<a download>` 点了没反应、
 * `target="_blank"` 开不了新窗口；同一份 Web 代码在浏览器里都好好的，进壳就失灵。
 * Web 形态下本模块全是 no-op（调用方按 `isDesktopShell()` 二选一，见 `lib/download.ts`）。
 */

import { tauriInvoke } from "./desktop-embed";

/** 把字节转 base64（分块拼，避免大文件一次性 `fromCharCode` 爆栈）。 */
function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/**
 * 落盘到系统下载目录（重名自动顺延），返回最终绝对路径；非桌面形态返回 null。
 * 文件名清洗与落点约束在 Rust 侧（只接受名字、不接受目标路径，落点固定下载目录）。
 */
export async function saveFileToDownloads(
  name: string,
  data: ArrayBuffer,
): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("save_file", {
    name,
    dataBase64: toBase64(data),
  })) as string;
}

/** 在系统文件管理器里定位文件（macOS 上就是「在访达中显示」）。 */
export async function revealPath(path: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("reveal_path", { path });
}

/** 外链交给系统默认浏览器（WKWebView 开不了新窗口）。 */
export async function openExternal(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("open_external", { url });
}

export async function openDataDirectory(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("请在桌面应用中打开数据目录。");
  await invoke("open_data_directory");
}

export async function moveDataDirectory(
  dataDir: string,
): Promise<{ dataDir: string }> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("请在桌面应用中迁移数据目录。");
  return (await invoke("move_data_directory", { dataDir })) as {
    dataDir: string;
  };
}

export async function openInBrowser(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("请在桌面应用中创建浏览器连接。");
  await invoke("open_in_browser");
}

/**
 * 桌面形态接管 `target="_blank"` 外链：WKWebView 开不了新窗口，点过去毫无反应——
 * 捕获阶段拦截后交给系统浏览器。重复调用安全（同一 document 只挂一次）。
 */
export function installDesktopExternalLinks(): void {
  const w = typeof window === "undefined" ? null : window;
  if (!w || w.__kfwExternalLinksInstalled) return;
  if (!tauriInvoke()) return;
  w.__kfwExternalLinksInstalled = true;
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.(
        "a[target='_blank']",
      ) as HTMLAnchorElement | null;
      const href = anchor?.getAttribute("href");
      // 只接管 http/https 外链；相对链接（应用内路由）照常走本页导航
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void openExternal(href);
    },
    true,
  );
}

declare global {
  interface Window {
    __kfwExternalLinksInstalled?: boolean;
  }
}
