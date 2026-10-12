import type { DesignRunHost } from "../execution/design-run-host-types.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";

type RestoreLease = {
  operationId: string;
  scopeGeneration: number;
  branchGeneration: number;
};

export function createDesignTaskRestore(options: {
  host: Pick<DesignRunHost, "beginRestore" | "finishRestore">;
  executionScopes: ExecutionScopes;
}) {
  const leases = new Map<string, RestoreLease>();
  const key = (scope: ExecutionScopeHandle) => {
    const identity = scope.describe();
    return `${identity.instanceId}:${identity.taskId}`;
  };

  return {
    async begin(
      scope: ExecutionScopeHandle,
      actor: LocalActor,
    ): Promise<ExecutionScopeHandle> {
      const identity = scope.describe();
      const lease = await options.host.beginRestore(actor, {
        taskId: identity.taskId,
        expectedScopeGeneration: identity.generation,
        expectedBranchGeneration: scope.branchGeneration,
      });
      try {
        const restoring = await options.executionScopes.openRestoringTask(
          actor,
          identity.taskId,
          lease.scopeGeneration,
        );
        const restoredIdentity = restoring.describe();
        if (
          restoring.preset !== "design" ||
          restoredIdentity.instanceId !== identity.instanceId ||
          restoredIdentity.projectId !== identity.projectId ||
          restoredIdentity.generation !== lease.scopeGeneration ||
          restoring.branchGeneration !== lease.branchGeneration
        )
          throw new Error("恢复工作域与 Design Task 不匹配。");
        leases.set(key(scope), {
          operationId: lease.operationId,
          scopeGeneration: lease.scopeGeneration,
          branchGeneration: lease.branchGeneration,
        });
        return restoring;
      } catch (error) {
        await options.host.finishRestore(actor, {
          taskId: identity.taskId,
          operationId: lease.operationId,
          scopeGeneration: lease.scopeGeneration,
          branchGeneration: lease.branchGeneration,
          state: "failed",
        });
        throw error;
      }
    },
    async finish(
      scope: ExecutionScopeHandle,
      actor: LocalActor,
      success: boolean,
    ): Promise<void> {
      const identity = scope.describe();
      const lease = leases.get(key(scope));
      if (!lease) throw new Error("Design Task 恢复租约已失效。");
      leases.delete(key(scope));
      const finished = await options.host.finishRestore(actor, {
        taskId: identity.taskId,
        operationId: lease.operationId,
        scopeGeneration: lease.scopeGeneration,
        branchGeneration: lease.branchGeneration,
        state: success ? "ready" : "failed",
      });
      if (!finished) throw new Error("Design Task 恢复租约已变化。");
    },
  };
}
