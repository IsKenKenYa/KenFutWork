import type { ToolExecutionContext } from "../../kernel/types.js";
import type { DesignTasksService } from "../execution/design-task-types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";

/** 画布资源不签发调用身份；Actor 必须来自真实运行时。 */
export async function resolveCanvasActor(
  instance: LocalInstanceService,
  context: ToolExecutionContext,
  tasks: Pick<DesignTasksService, "readPolicy">,
): Promise<LocalActor> {
  const actor = context.actor;
  if (!actor) throw new Error("画布工具缺少可信本地调用上下文。");
  const handle = context.scopeHandle;
  if (!handle || handle.preset !== "design" || !context.runId)
    throw new Error("画布工具必须绑定真实Design Task与Run。");
  if (
    actor.instanceId !== context.instanceId ||
    (context.scopeHandle &&
      context.scopeHandle.describe().instanceId !== actor.instanceId)
  )
    throw new Error("画布实例与可信 Task 工作域不匹配。");
  await instance.resolve(actor);
  context.signal?.throwIfAborted();
  const scope = handle.describe();
  await handle.resolvePath(".", "read");
  const policy = await tasks.readPolicy(actor, scope.taskId);
  if (
    policy.projectId !== scope.projectId ||
    policy.canvasId !== context.canvasId ||
    policy.activeRunId !== context.runId ||
    policy.scopeGeneration !== scope.generation ||
    policy.branchGeneration !== handle.branchGeneration ||
    policy.executionState !== "ready"
  )
    throw new Error("画布与当前Task或运行授权不匹配。");
  context.signal?.throwIfAborted();
  return actor;
}
