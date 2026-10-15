import { lstat } from "node:fs/promises";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { PersistenceService } from "../persistence/types.js";

export function createProjectLayoutFiles(persistence: PersistenceService) {
  return async (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
  ): Promise<readonly string[]> => {
    const identity = scope.describe();
    if (actor.instanceId !== identity.instanceId) return [];
    const rows = await persistence
      .forInstance(identity.instanceId)
      .query<{ canvas_id: string }>(
        `select c.id as canvas_id from public.canvases c
         join public.projects p on p.id=c.project_id
         join public.code_ui_sessions t on t.project_id=p.id and t.instance_id=p.instance_id
        where p.instance_id=:instance and t.id=$1 and p.id=$2
          and t.parent_session_id is null and t.deleted_at is null
          and t.scope_generation=$3 and t.branch_generation=$4
          and c.deleted_at is null and c.root_directory=$5`,
        [
          identity.taskId,
          identity.projectId,
          identity.generation,
          scope.branchGeneration,
          identity.rootDirectory,
        ],
      );
    const paths: string[] = [];
    for (const row of rows) {
      const path = `.kenfutwork/canvases/${row.canvas_id}.json`;
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
      if (file?.isFile()) paths.push(path);
    }
    return paths;
  };
}
