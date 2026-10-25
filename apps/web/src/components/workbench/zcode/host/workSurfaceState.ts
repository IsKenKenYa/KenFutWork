/**
 * Work 主区子视图的模块级存储（同 flowSurfaceState 形态）：信息页 ↔ 编辑器面
 * 的切换只在**显式用户动作**时发生（打开 / 返回），主区不被会话或后台事件顶掉
 * ——与 Design/Flow 同一条不变量。编辑器面按 editorId 记忆，切回信息页后
 * 再点「打开」回到同一编辑器。
 */
export type WorkSurfaceView =
  | { kind: "editors" }
  | { kind: "editor"; editorId: string };

let state: WorkSurfaceView = { kind: "editors" };
const listeners = new Set<() => void>();

export function getWorkSurfaceView(): WorkSurfaceView {
  return state;
}

export function subscribeWorkSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: WorkSurfaceView): void {
  state = next;
  for (const listener of listeners) listener();
}

export function openWorkEditor(editorId: string): void {
  set({ kind: "editor", editorId });
}

export function openWorkEditors(): void {
  set({ kind: "editors" });
}
