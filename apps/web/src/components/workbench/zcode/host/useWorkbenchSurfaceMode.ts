import type { WorkspaceMainView } from "@zui/app-shell/types.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { admitProjectMode } from "./SharedProjectNavigation.js";

const EMPTY_SNAPSHOT = {
  mode: "code" as const,
  availableModes: [] as readonly never[],
};
const NOOP_SUBSCRIBE = () => () => {};
/** 视图归属：design/flow/work 各自独占；chat/automations/plugin-store 属于 code 家族。 */
const viewMode = (target: WorkspaceMainView) =>
  target === "design" || target === "flow" || target === "work"
    ? target
    : "code";

/** 切到某模式时缺省落到的主区视图（work 与 code 共用同一会话主区）。 */
const defaultView = (mode: ReturnType<typeof viewMode>): WorkspaceMainView =>
  mode === "design" || mode === "flow" ? mode : "chat";

/**
 * 视图是否属于当前模式：code 家族的共享页面（会话/自动化/插件市场）在 code 与
 * work 两个模式下都成立——work 的主区就是共享会话，引擎页只是它的一个显式视图。
 */
const viewBelongs = (
  target: WorkspaceMainView,
  mode: ReturnType<typeof viewMode>,
) =>
  viewMode(target) === mode ||
  (viewMode(target) === "code" && (mode === "code" || mode === "work"));

/**
 * 工作台模式 ↔ 主区视图的同步（融合缝）。
 *
 * 单向数据流：模式（导航存储，pills 点击 / 父窗口推送改写）→ 主区视图；
 * 视图变化后把模式回显进存储（pills 的 active 态）。两侧 effect 都做相等短路，
 * 不会形成回环。design/flow 视图各自独占一个模式；chat/automations/plugin-store
 * 是 code 与 work 共用的页面，出现时不改写模式。
 */
export function useWorkbenchSurfaceMode({
  workspaceMainView,
  setWorkspaceMainView,
}: {
  workspaceMainView: WorkspaceMainView;
  setWorkspaceMainView: (view: WorkspaceMainView) => void;
}): "code" | "design" | "flow" | "work" {
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
      requested && viewBelongs(requested, snapshot.mode)
        ? requested
        : viewBelongs(view.current, snapshot.mode)
          ? view.current
          : defaultView(snapshot.mode);
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
    // 共享页面（会话/自动化/插件市场）在 code 与 work 下都成立，不改写模式。
    if (viewBelongs(workspaceMainView, snapshot.mode)) return;
    const mode = viewMode(workspaceMainView);
    const version = ++requestVersion.current;
    requestedView.current = workspaceMainView;
    const retainedView = defaultView(snapshot.mode);
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
  return snapshot.mode;
}
