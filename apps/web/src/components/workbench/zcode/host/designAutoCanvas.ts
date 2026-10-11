/**
 * Design 主区「自动进画布」的决策（融合后从原 web lib design-auto-canvas 迁入，
 * 语义不变，输入收敛到内嵌面实际拥有的状态）。
 *
 * **为什么要按列表判定**：选中记忆跨视图保留（design → code → design 不丢画布），
 * 残留的选中 id 在项目列表里不存在时不能「保持现状」——否则主区会永远停在
 * 空态，画布开不出来。教训（原 AGENTS.md 不变量）：跨上下文共享的选中态，
 * 判定必须按本列表过滤。
 */
export type DesignAutoCanvasDecision =
  /** 正在建项目：不动作。 */
  | { kind: "idle" }
  /** 已选中本列表里的项目：保持。 */
  | { kind: "keep" }
  /** 选中列表里的第一个项目。 */
  | { kind: "select"; projectId: string }
  /** 一个项目都没有：自动建一张空白画布。 */
  | { kind: "create" }
  /** 建过一次了（可能失败）：不再重试，交给用户手动新建。 */
  | { kind: "give-up" };

export function resolveDesignAutoCanvas(input: {
  creatingProject: boolean;
  /** 画布项目列表是否至少取过一次（成功或失败）。 */
  projectsLoaded: boolean;
  /** 画布项目 id（顺序即「第一个」）。 */
  projectIds: readonly string[];
  selectedProjectId: string | null;
  /** 是否已经尝试过自动创建（避免列表拉取失败时反复发创建请求）。 */
  autoCreateTried: boolean;
}): DesignAutoCanvasDecision {
  if (input.creatingProject) return { kind: "idle" };
  if (
    input.selectedProjectId &&
    input.projectIds.includes(input.selectedProjectId)
  ) {
    return { kind: "keep" };
  }
  if (!input.projectsLoaded) return { kind: "idle" };
  const first = input.projectIds[0];
  if (first) return { kind: "select", projectId: first };
  return input.autoCreateTried ? { kind: "give-up" } : { kind: "create" };
}
