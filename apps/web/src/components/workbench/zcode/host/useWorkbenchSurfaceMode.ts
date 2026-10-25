import type { WorkspaceMainView } from "@zui/app-shell/types.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { admitProjectMode } from "./SharedProjectNavigation.js";

const EMPTY_SNAPSHOT = {
  mode: "code" as const,
  availableModes: [] as readonly never[],
};
const NOOP_SUBSCRIBE = () => () => {};
const viewMode = (target: WorkspaceMainView) =>
  target === "design" || target === "flow" || target === "work"
    ? target
    : "code";

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
  const view = useRef(workspaceMainView);
  view.current = workspaceMainView;
  const previousView = useRef(workspaceMainView);
  const expectedView = useRef<WorkspaceMainView | null>(null);
  const requestedView = useRef<WorkspaceMainView | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!navigation) return;
    requestVersion.current++;
    const requested = requestedView.current;
    const target =
      requested && viewMode(requested) === snapshot.mode
        ? requested
        : snapshot.mode === "code"
          ? viewMode(view.current) === "code"
            ? view.current
            : "chat"
          : snapshot.mode;
    requestedView.current = null;
    expectedView.current = target === view.current ? null : target;
    previousView.current = target;
    if (target !== view.current) setWorkspaceMainView(target);
  }, [snapshot.mode, navigation, setWorkspaceMainView]);

  useEffect(() => {
    if (!navigation) return;
    if (expectedView.current) {
      if (expectedView.current === workspaceMainView) {
        expectedView.current = null;
        previousView.current = workspaceMainView;
      }
      return;
    }
    if (previousView.current === workspaceMainView) return;
    previousView.current = workspaceMainView;
    const mode = viewMode(workspaceMainView);
    if (mode === snapshot.mode) return;
    const version = ++requestVersion.current;
    requestedView.current = workspaceMainView;
    const retainedView = snapshot.mode === "code" ? "chat" : snapshot.mode;
    expectedView.current = retainedView;
    setWorkspaceMainView(retainedView);
    if (!snapshot.availableModes.includes(mode)) {
      requestedView.current = null;
      return;
    }
    void (
      mode === "flow" || mode === "work"
        ? Promise.resolve(true)
        : admitProjectMode(mode)
    ).then((allowed) => {
      if (version !== requestVersion.current) return;
      if (allowed) navigation.setActiveMode(mode);
      else requestedView.current = null;
    });
  }, [workspaceMainView, navigation, snapshot.mode, setWorkspaceMainView]);
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [navigation],
  );
}
