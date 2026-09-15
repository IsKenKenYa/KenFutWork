import type { WorkbenchMode } from "./workbench-surface";

/**
 * Design 模式「自动进画布」的决策（唯一判定处，供 workbench 的 effect 与测试共用）。
 *
 * **为什么要按本模式的项目判定**：`selectedProjectId` 在 Code/Design 之间共用同一个槽
 * （切模式刻意不清，免得切回来丢掉工作目录）。于是 Code 的工作目录 id 在 Design 的
 * 项目列表里根本不存在——此前判「selectedProjectId 为真就保持现状」，切到 Design 时
 * 残留的 Code 项目 id 会把自动进画布整段挡掉，主区停在居中编排器（用户认成「Design
 * 抄了 Code 模式」），画布再也开不出来。教训：**跨模式共享的状态，判定必须按模式过滤**。
 */
export type DesignAutoCanvasDecision =
  /** 不适用（非 Design / 有任务视图 / 正在建项目 / 列表还没回来）。 */
  | { kind: "idle" }
  /** 已选中本模式的项目：保持。 */
  | { kind: "keep" }
  /** 选中列表里的第一个项目。 */
  | { kind: "select"; projectId: string }
  /** 一个项目都没有：自动建一个空白画布。 */
  | { kind: "create" }
  /** 建过一次了（可能失败）：不再重试，交给侧栏手动新建。 */
  | { kind: "give-up" };

export function resolveDesignAutoCanvas(input: {
  mode: WorkbenchMode;
  activeTaskId: string | null;
  creatingProject: boolean;
  /** 画布项目列表是否至少取过一次（成功或失败）。 */
  projectsLoaded: boolean;
  /** 本模式的画布项目 id（顺序即「第一个」）。 */
  designProjectIds: readonly string[];
  selectedProjectId: string | null;
  /** 是否已经尝试过自动创建（避免列表拉取失败时反复发创建请求）。 */
  autoCreateTried: boolean;
}): DesignAutoCanvasDecision {
  if (input.mode !== "design") return { kind: "idle" };
  if (input.activeTaskId || input.creatingProject) return { kind: "idle" };
  if (
    input.selectedProjectId &&
    input.designProjectIds.includes(input.selectedProjectId)
  ) {
    return { kind: "keep" };
  }
  if (!input.projectsLoaded) return { kind: "idle" };
  const first = input.designProjectIds[0];
  if (first) return { kind: "select", projectId: first };
  return input.autoCreateTried ? { kind: "give-up" } : { kind: "create" };
}
