import type { ToolExecutionContext } from "../../kernel/types.js";

/**
 * Computer Use 工具执行前的可信上下文校验。
 *
 * 保留实例、Run 与主代理隔离；Task/项目一致性只在两侧都存在时校验，
 * 使 code/design 及无 Task 形态的运行都能使用，同时子代理和外部 Run 仍被拒绝。
 */
export function cuContextDenial(context: ToolExecutionContext): string | null {
  const actor = context.actor;
  if (!actor || !context.runId || !context.toolCallId)
    return "桌面控制缺少可信实例和Run上下文";
  if (actor.instanceId !== context.instanceId)
    return "桌面控制的实例与运行实例不一致";
  if (context.scopeHandle && context.scopeHandle.role !== "main")
    return "桌面控制只允许主代理调用";
  if ((context.delegationDepth ?? 0) > 0) return "桌面控制不允许子代理调用";
  const work = context.taskWorkContext;
  if (!work) return null;
  if (!work.actor || work.actor.instanceId !== actor.instanceId)
    return "桌面控制的Task与运行实例不一致";
  if (work.runId !== context.runId) return "桌面控制的Task不属于当前Run";
  const scope = context.scopeHandle?.describe();
  if (
    scope &&
    (work.scope.instanceId !== scope.instanceId ||
      work.scope.taskId !== scope.taskId ||
      work.scope.projectId !== scope.projectId)
  )
    return "桌面控制的Task与执行作用域不一致";
  return null;
}
