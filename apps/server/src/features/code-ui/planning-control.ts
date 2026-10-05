import type { CodeExecutionScope } from "@kenfutwork/shared";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { PermissionInvocation } from "../permissions/approval-types.js";
import { matchesActiveCodeRun } from "./active-run-binding.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";

type EnterPlanCall = {
  context: ToolExecutionContext;
  scope: CodeExecutionScope;
  handle: ExecutionScopeHandle;
  invocation: PermissionInvocation;
  signal: AbortSignal;
};

function requireEnterPlanCall(context: ToolExecutionContext): EnterPlanCall {
  const handle = context.scopeHandle;
  const scope = handle?.describe();
  const invocation = context.permissionInvocation;
  const work = context.taskWorkContext;
  const signal = context.signal;
  if (
    !scope ||
    !handle ||
    !invocation ||
    !work ||
    !signal ||
    !context.runId ||
    !context.toolCallId ||
    handle.role !== "main" ||
    handle.agentId !== "main" ||
    context.actor?.instanceId !== scope.instanceId ||
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
    invocation.planControl !== "enter" ||
    invocation.access !== undefined ||
    invocation.toolName !== ENTER_PLAN_MODE_TOOL_NAME ||
    work.scope.instanceId !== scope.instanceId ||
    work.scope.taskId !== scope.taskId ||
    work.scope.rootDirectory !== scope.rootDirectory ||
    work.scope.generation !== scope.generation ||
    work.agentId !== handle.agentId ||
    work.runId !== context.runId ||
    work.actor?.instanceId !== scope.instanceId
  )
    throw new Error(
      "EnterPlanMode必须绑定真实主Task工具调用、授权代际与取消信号。",
    );
  if (
    !invocation.args ||
    typeof invocation.args !== "object" ||
    Array.isArray(invocation.args) ||
    Object.keys(invocation.args).length !== 0
  )
    throw new Error("EnterPlanMode的可信调用参数必须为空对象。");
  signal.throwIfAborted();
  // SDK工具signal可由父Run与调用取消合成；不按对象身份否认合法绑定。
  work.signal?.throwIfAborted();
  return { context, scope, handle, invocation, signal };
}

function requireActiveRun(
  root: CodeUiSessionRecord | null,
  call: EnterPlanCall,
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
    throw new Error("规划所属Run或Task授权代际已失效，未开启规划。");
  const snapshot = root.state.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (
    !snapshot ||
    snapshot.control.phase !== "running" ||
    !snapshot.control.activeWorks.some(
      (work) =>
        work.kind === "primaryTurn" &&
        work.foregroundExecutionId === invocation.runId,
    )
  )
    throw new Error("EnterPlanMode要求同一主Run仍在执行。");
  return { root, state: root.state, snapshot };
}

/** Provider：只收紧真实主Task规划状态；工具生命周期仍由原observer持有。 */
export function createCodePlanningControl(deps: {
  repository: CodeUiRepository;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
}) {
  return {
    async enter(context: ToolExecutionContext): Promise<unknown> {
      const call = requireEnterPlanCall(context);
      const { scope, invocation } = call;
      await call.handle.resolvePath(".", "read");
      requireActiveRun(
        await deps.repository.find(scope.instanceId, scope.taskId),
        call,
      );
      const event = {
        type: "plan.entered",
        instanceId: invocation.instanceId,
        taskId: invocation.taskId,
        runId: invocation.runId,
        toolCallId: invocation.toolCallId,
        agentId: invocation.agentId,
        role: invocation.role,
        scopeGeneration: invocation.scopeGeneration,
        branchGeneration: invocation.branchGeneration,
      };
      await deps.repository.appendEvent(
        scope.instanceId,
        scope.taskId,
        {
          key: `plan-enter:${invocation.runId}/${invocation.toolCallId}`,
          fingerprint: parameterFingerprint(event),
          event,
        },
        (current) => {
          const { state, snapshot } = requireActiveRun(
            { ...current, state: structuredClone(current.state) },
            call,
          );
          snapshot.config.planEnabled = true;
          snapshot.seq += 1;
          snapshot.revision += 1;
          return { state, activeRunId: current.active_run_id };
        },
      );
      // 重复事件不执行apply；复验当前事实，不能为停止/撤权后的重放报成功。
      const { root } = requireActiveRun(
        await deps.repository.find(scope.instanceId, scope.taskId),
        call,
      );
      await deps.refresh(
        scope.instanceId,
        scope.rootDirectory,
        root.project_id,
      );
      await call.handle.resolvePath(".", "read");
      const { snapshot } = requireActiveRun(
        await deps.repository.find(scope.instanceId, scope.taskId),
        call,
      );
      if (snapshot.config.planEnabled !== true)
        throw new Error("规划状态未持久开启，EnterPlanMode未完成。");
      const content =
        "规划模式已开启（planEnabled: true）。当前Task仅允许只读调查与规划；现有Task权限不会因此提升。";
      return {
        canonicalOutput: { planEnabled: true, content },
        modelContent: [{ type: "text", text: content }],
      };
    },
  };
}
