import type { ToolExecutionContext } from "../../kernel/types.js";
import type { CodeUiSessionRecord } from "./repository.js";

/** 私有宿主绑定；guide和规划控制消费同一活动主Run与Task授权事实。 */
export function matchesActiveCodeRun(
  root: CodeUiSessionRecord,
  context: ToolExecutionContext,
): boolean {
  const scope = context.scopeHandle?.describe();
  return (
    !!scope &&
    context.actor?.instanceId === scope.instanceId &&
    context.scopeHandle?.role === "main" &&
    context.scopeHandle.agentId === "main" &&
    root.active_run_id === context.runId &&
    root.state?.runId === context.runId &&
    root.execution_state === "ready" &&
    root.root_directory === scope.rootDirectory &&
    !root.archived &&
    !root.deleted_at &&
    Number(root.scope_generation) === scope.generation &&
    Number(root.branch_generation) === context.taskWorkContext?.branchGeneration
  );
}
