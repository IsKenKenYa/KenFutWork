/**
 * 桌面形态（Tauri 外壳）里的**真内核浏览器嵌入**桥（路线 2）。
 *
 * Web 形态下面板里的页面只能挂 iframe：站点不让嵌就白屏，而且**浏览器不允许给 iframe 挂调试器**。
 * 桌面形态由 Rust 侧（`apps/desktop/src-tauri/src/browser_embed.rs`）嵌一个真 WebView2
 * （Chromium 内核）——嵌入限制不存在，调试控制台直接注入进页面（`browser_embed_console`）。
 *
 * 这一层的三个细节：
 * - **子 webview 不随网页滚动/裁剪**，是独立的一层：所以要在面板里留一个占位块，把它的
 *   `getBoundingClientRect()` 同步过去（`browser_embed_bounds`）；
 * - 检测靠 Tauri 注入的全局对象，**不引 npm 依赖**（`withGlobalTauri: true`）；
 * - Web 形态下全部是 no-op（`isDesktopShell() === false`），调用方按它二选一。
 */

interface TauriInvoke {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** Tauri v2 注入的全局对象（`withGlobalTauri: true` 时存在）。 */
function tauriInvoke(): TauriInvoke["invoke"] | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    __TAURI__?: { core?: TauriInvoke };
    __TAURI_INTERNALS__?: TauriInvoke;
  };
  const invoke = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

/** 是否跑在桌面外壳里（决定浏览器面板用原生嵌入还是 iframe）。 */
export function isDesktopShell(): boolean {
  return tauriInvoke() !== null;
}

export interface EmbedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 从占位块量出边界（DPR 无关：Rust 侧收的是逻辑像素）。 */
export function boundsOf(element: Element): EmbedBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** 打开（或换址）嵌入页面：不存在就建，存在就导航 + 挪位置。 */
export async function embedOpen(
  url: string,
  bounds: EmbedBounds,
): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("browser_embed_open", { url, bounds });
}

/** 同步边界（滚动 / 拖面板 / 切标签都要调）。 */
export async function embedBounds(bounds: EmbedBounds): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("browser_embed_bounds", { bounds });
}

/** 显隐（面板收起/切标签：隐藏比销毁便宜）。 */
export async function embedVisible(visible: boolean): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("browser_embed_visible", { visible });
}

/**
 * 往嵌入页面里**注入调试控制台**（Eruda）：面板页面底部直接出现 Console / Elements /
 * Network 面板——与 Web 形态同一条口径（用户口径：调试面板要在内嵌页面里出来，
 * 而不是另开一层窗口）。
 *
 * `script` 由调用方从服务端取（`/api/browser/debug-console.js`）：两端共用同一份源码，
 * 各自存一份迟早漂移。
 */
export async function embedDebugConsole(script: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("browser_embed_console", { script });
}

/** 关掉嵌入实例（离开面板/换会话时调，别让页面在后台一直跑）。 */
export async function embedClose(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("browser_embed_close");
}
