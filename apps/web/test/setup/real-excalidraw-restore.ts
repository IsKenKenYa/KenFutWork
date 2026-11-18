import { vi } from "vitest";

/** jsdom 缺少 Canvas2D；仅补真实包初始化时的浏览器能力探测，恢复算法使用原包。 */
export async function loadRealRestoreElements() {
  const context = { filter: "none" } as CanvasRenderingContext2D;
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context);
  try {
    return (await import("@excalidraw/excalidraw")).restoreElements;
  } finally {
    getContext.mockRestore();
  }
}
