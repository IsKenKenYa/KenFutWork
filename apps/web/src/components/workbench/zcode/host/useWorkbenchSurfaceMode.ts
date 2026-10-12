import type { WorkspaceMainView } from "@zui/app-shell/types.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useEffect, useSyncExternalStore } from "react";

const EMPTY_SNAPSHOT = {
  mode: "code" as const,
  availableModes: [] as readonly never[],
};
const NOOP_SUBSCRIBE = () => () => {};

/**
 * 工作台模式 ↔ 主区视图的同步（融合缝）。
 *
 * 单向数据流：模式（导航存储，pills 点击 / 父窗口推送改写）→ 主区视图；
 * 视图变化后把模式回显进存储（pills 的 active 态）。两侧 effect 都做相等短路，
 * 不会形成回环。非 design/flow 视图一律回写 code——automations/plugin-store
 * 与对话视图都属于 Code 模式的壳内页面。
 */
export function useWorkbenchSurfaceMode({
  workspaceMainView,
  setWorkspaceMainView,
}: {
  workspaceMainView: WorkspaceMainView;
  setWorkspaceMainView: (view: WorkspaceMainView) => void;
}): void {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const snapshot = useSyncExternalStore(
    navigation?.subscribe ?? NOOP_SUBSCRIBE,
    navigation?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );

  useEffect(() => {
    if (!navigation) return;
    if (snapshot.mode === "design" || snapshot.mode === "flow") {
      if (workspaceMainView !== snapshot.mode) {
        setWorkspaceMainView(snapshot.mode);
      }
      return;
    }
    if (workspaceMainView === "design" || workspaceMainView === "flow") {
      setWorkspaceMainView("chat");
    }
  }, [snapshot.mode, workspaceMainView, navigation, setWorkspaceMainView]);

  useEffect(() => {
    const mode =
      workspaceMainView === "design" || workspaceMainView === "flow"
        ? workspaceMainView
        : "code";
    navigation?.setActiveMode(mode);
  }, [workspaceMainView, navigation]);
}
