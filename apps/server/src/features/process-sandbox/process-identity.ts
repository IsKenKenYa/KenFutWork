import type { SandboxProcessScope } from "./types.js";

/** Project 租约有独立身份空间，任何位置都不使用 Task id 代替它。 */
export function processOwnerKey(scope: SandboxProcessScope): string {
  return "kind" in scope
    ? JSON.stringify([
        "project-read",
        scope.instanceId,
        scope.projectId,
        scope.connectionId,
        scope.revision,
        scope.leaseId,
      ])
    : scope.taskId;
}
