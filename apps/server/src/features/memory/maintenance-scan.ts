import type { LocalActor } from "../local-instance/types.js";

/**
 * 一轮记忆整理：关闭记忆的实例直接跳过；其余按 Code 与 Design 两端的项目逐个整理。
 * 单个项目失败只记入 `failed`，不影响同轮其它项目，也不影响下一轮周期扫描。
 */
export async function runMemoryMaintenanceScan(deps: {
  actor: LocalActor;
  isEnabled: (instanceId: string) => boolean | Promise<boolean>;
  listProjects: (
    actor: LocalActor,
    kind: "code" | "design",
  ) => Promise<Array<{ id: string }>>;
  maintain: (projectId: string) => Promise<unknown>;
}): Promise<{ skipped: boolean; maintained: string[]; failed: string[] }> {
  if (!(await deps.isEnabled(deps.actor.instanceId)))
    return { skipped: true, maintained: [], failed: [] };
  const projects = [
    ...(await deps.listProjects(deps.actor, "code")),
    ...(await deps.listProjects(deps.actor, "design")),
  ];
  const maintained: string[] = [];
  const failed: string[] = [];
  for (const project of projects) {
    try {
      await deps.maintain(project.id);
      maintained.push(project.id);
    } catch {
      failed.push(project.id);
    }
  }
  return { skipped: false, maintained, failed };
}
