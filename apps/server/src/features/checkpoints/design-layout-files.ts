import { lstat } from "node:fs/promises";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { PersistenceService } from "../persistence/types.js";

export function createDesignLayoutFiles(persistence: PersistenceService) {
  return async (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
  ): Promise<readonly string[]> => {
    if (scope.preset !== "design") return [];
    const identity = scope.describe();
    if (actor.instanceId !== identity.instanceId) return [];
    const rows = await persistence
      .forInstance(identity.instanceId)
      .query<{ canvas_id: string }>(
        `select c.id as canvas_id from public.execution_task_owners o
         join public.design_task_executions d on d.instance_id=o.instance_id
           and d.task_id=o.task_id and d.project_id=o.project_id
         join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id
           and s.project_id=d.project_id and s.mode='design'
         join public.canvases c on c.id=s.canvas_id and c.project_id=d.project_id
         join public.projects p on p.id=d.project_id and p.instance_id=d.instance_id
        where o.instance_id=:instance and o.task_id=$1 and o.project_id=$2
          and o.task_kind='design' and p.kind='design' and p.archived_at is null
          and d.execution_state in ('ready','revoking') and d.scope_generation=$3
          and d.branch_generation=$4`,
        [
          identity.taskId,
          identity.projectId,
          identity.generation,
          scope.branchGeneration,
        ],
      );
    if (rows.length !== 1 || !rows[0]?.canvas_id) return [];
    const path = `.kenfutwork/canvases/${rows[0].canvas_id}.json`;
    const canonical = await scope.resolvePath(path, "read");
    const file = await lstat(canonical).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    return file?.isFile() ? [path] : [];
  };
}
