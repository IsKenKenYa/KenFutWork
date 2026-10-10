import type { IPlatformService } from "@zcode/shared";

interface NativeWindow {
  startDragging(): Promise<void>;
  toggleMaximize(): Promise<void>;
  setTheme(theme: "light" | "dark" | null): Promise<void>;
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

function macWindow(): NativeWindow | null {
  if (
    typeof window === "undefined" ||
    !/Macintosh|Mac OS X/u.test(navigator.userAgent)
  )
    return null;
  try {
    const parent = window.parent as Window & {
      __TAURI__?: { window?: { getCurrentWindow(): NativeWindow } };
    };
    if (parent.location.origin !== window.location.origin) return null;
    return parent.__TAURI__?.window?.getCurrentWindow() ?? null;
  } catch {
    return null;
  }
}

/** 原Electron窗口接口映射到既有Tauri主窗口；Web保持原布局。 */
export function createMacDesktopChrome(): Pick<
  IPlatformService,
  | "getWindowControlsOverlayMetrics"
  | "onWindowFullscreenChanged"
  | "setTitleBarTheme"
> | null {
  const native = macWindow();
  if (!native) return null;
  return {
    getWindowControlsOverlayMetrics: () => ({
      leftPaddingPx: 96,
      titleBarHeightPx: 56,
    }),
    setTitleBarTheme: (theme) =>
      native.setTheme(theme === "system" ? null : theme),
    onWindowFullscreenChanged: (handler) => {
      let disposed = false,
        revision = 0;
      let release: (() => void) | undefined;
      const update = async () => {
        const current = ++revision;
        const fullscreen = await native.isFullscreen();
        if (!disposed && current === revision) handler(fullscreen);
      };
      const refresh = () => {
        void update().catch(console.error);
      };
      void native
        .onResized(refresh)
        .then((unsubscribe) => {
          if (disposed) unsubscribe();
          else release = unsubscribe;
        })
        .catch(console.error);
      refresh();
      return () => {
        disposed = true;
        release?.();
      };
    },
  };
}

/** 识别原源码drag/no-drag标记；Tauri不会消费Electron的app-region CSS。 */
export function installDesktopTitlebarDrag(target: Document): () => void {
  const native = macWindow();
  if (!native) return () => {};
  const isDragRegion = (event: MouseEvent) => {
    let drag = false;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (
        node.classList.contains("[app-region:no-drag]") ||
        node.matches(
          "button,a,input,textarea,select,[role=button],[role=radio],[contenteditable=true]",
        )
      )
        return false;
      if (node.classList.contains("[app-region:drag]")) drag = true;
    }
    return drag;
  };
  const down = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail > 1 || !isDragRegion(event)) return;
    event.preventDefault();
    void native.startDragging().catch(console.error);
  };
  const double = (event: MouseEvent) => {
    if (event.button !== 0 || !isDragRegion(event)) return;
    event.preventDefault();
    void native.toggleMaximize().catch(console.error);
  };
  target.addEventListener("mousedown", down, true);
  target.addEventListener("dblclick", double, true);
  return () => {
    target.removeEventListener("mousedown", down, true);
    target.removeEventListener("dblclick", double, true);
  };
}
