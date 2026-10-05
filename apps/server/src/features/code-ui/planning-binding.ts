import type { CodeExecutionScope } from "@kenfutwork/shared";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { PermissionInvocation } from "../permissions/approval-types.js";
import { matchesActiveCodeRun } from "./active-run-binding.js";
import type { CodeUiSessionRecord } from "./repository.js";

export type CodePlanningCall = {
  context: ToolExecutionContext;
  scope: CodeExecutionScope;
  handle: ExecutionScopeHandle;
  invocation: PermissionInvocation;
  signal: AbortSignal;
  actor: LocalActor;
};

export function requirePlanningCall(
  context: ToolExecutionContext,
  control: "enter" | "exit",
): CodePlanningCall {
  const handle = context.scopeHandle;
  const scope = handle?.describe();
  const invocation = context.permissionInvocation;
  const work = context.taskWorkContext;
  const signal = context.signal;
  const actor = context.actor;
  if (
    !scope ||
    !handle ||
    !invocation ||
    !work ||
    !signal ||
    !actor ||
    !context.runId ||
    !context.toolCallId ||
    handle.role !== "main" ||
    handle.agentId !== "main" ||
    actor.instanceId !== scope.instanceId ||
    invocation.preset !== "code" ||
    invocation.instanceId !== scope.instanceId ||
    invocation.taskId !== scope.taskId ||
    invocation.runId !== context.runId ||
    invocation.toolCallId !== context.toolCallId ||
    invocation.agentId !== handle.agentId ||
    invocation.role !== handle.role ||
    invocation.scopeGeneration !== scope.generation ||
    invocation.branchGeneration !== work.branchGeneration ||
    invocation.signal !== signal ||
    invocation.planControl !== control ||
    invocation.access !== undefined ||
    invocation.toolName !==
      (control === "enter" ? "EnterPlanMode" : "ExitPlanMode") ||
    work.scope.instanceId !== scope.instanceId ||
    work.scope.taskId !== scope.taskId ||
    work.scope.rootDirectory !== scope.rootDirectory ||
    work.scope.generation !== scope.generation ||
    work.agentId !== handle.agentId ||
    work.runId !== context.runId ||
    work.actor?.instanceId !== scope.instanceId
  )
    throw new Error("规划控制必须绑定真实主Task工具调用、授权代际与取消信号。");
  if (
    control === "enter" &&
    (!invocation.args ||
      typeof invocation.args !== "object" ||
      Array.isArray(invocation.args) ||
      Object.keys(invocation.args).length !== 0)
  )
    throw new Error("EnterPlanMode的可信调用参数必须为空对象。");
  signal.throwIfAborted();
  // SDK工具signal可由父Run与调用取消合成；不按对象身份否认合法绑定。
  work.signal?.throwIfAborted();
  return { context, scope, handle, invocation, signal, actor };
}

export function requireActivePlanningRun(
  root: CodeUiSessionRecord | null,
  call: CodePlanningCall,
) {
  call.signal.throwIfAborted();
  const { scope, invocation } = call;
  if (
    !root?.state ||
    root.id !== scope.taskId ||
    root.instance_id !== scope.instanceId ||
    root.parent_session_id !== null ||
    root.root_session_id !== root.id ||
    !matchesActiveCodeRun(root, call.context)
  )
    throw new Error("规划所属Run或Task授权代际已失效，控制未完成。");
  const snapshot = root.state.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (
    snapshot?.control.phase !== "running" ||
    !snapshot.control.activeWorks.some(
      (work) =>
        work.kind === "primaryTurn" &&
        work.foregroundExecutionId === invocation.runId,
    )
  )
    throw new Error("规划控制要求同一主Run仍在执行。");
  return { root, state: root.state, snapshot };
}
