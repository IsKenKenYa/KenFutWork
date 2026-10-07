import type { PromptExecutionContext, ToolExecutionContext } from "./types.js";

/** 同一Harness的实际定位事实；不把工具grant或完整业务状态传入提示。 */
export function promptExecutionContext(
  context: ToolExecutionContext,
): PromptExecutionContext {
  return {
    actor: context.actor,
    scopeHandle: context.scopeHandle,
    taskWorkContext: context.taskWorkContext,
    runId: context.runId,
    signal: context.signal,
  };
}
