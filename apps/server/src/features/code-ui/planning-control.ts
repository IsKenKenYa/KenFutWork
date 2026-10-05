import type { ToolExecutionContext } from "../../kernel/types.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { CodeApprovedPlanStore } from "./approved-plan-store.js";
import type { CodePlanningCall } from "./planning-binding.js";
import {
  requireActivePlanningRun,
  requirePlanningCall,
} from "./planning-binding.js";
import type { CodeUiRepository } from "./repository.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";

function requirePendingPlan(
  root: Awaited<ReturnType<CodeUiRepository["find"]>>,
  call: CodePlanningCall,
) {
  const current = requireActivePlanningRun(root, call);
  if (
    current.snapshot.config.planEnabled !== true ||
    !Number.isSafeInteger(call.invocation.planningEpoch) ||
    (current.state.planningEpoch ?? 0) !== call.invocation.planningEpoch
  )
    throw new Error("计划所属规划代际已失效，原批准不能退出当前规划。");
  return current;
}

/** Provider：只收紧真实主Task规划状态；工具生命周期仍由原observer持有。 */
export function createCodePlanningControl(deps: {
  repository: CodeUiRepository;
  localInstance: LocalInstanceService;
  files: CodeApprovedPlanStore;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
}) {
  const plans = deps.files;
  return {
    async exit(context: ToolExecutionContext): Promise<unknown> {
      const call = requirePlanningCall(context, "exit");
      const { scope, invocation } = call;
      const plan = invocation.args.plan;
      if (typeof plan !== "string" || !plan.trim())
        throw new Error("计划正文不能为空。");
      await call.handle.resolvePath(".", "read");
      requirePendingPlan(
        await deps.repository.find(scope.instanceId, scope.taskId),
        call,
      );
      const release = deps.localInstance.beginAdmission();
      try {
        const owner = await deps.localInstance.resolve(call.actor);
        const identity = {
          instanceId: invocation.instanceId,
          taskId: invocation.taskId,
          runId: invocation.runId,
          toolCallId: invocation.toolCallId,
          agentId: invocation.agentId,
          role: invocation.role,
          scopeGeneration: invocation.scopeGeneration,
          branchGeneration: invocation.branchGeneration,
          planningEpoch: invocation.planningEpoch,
        };
        const planRef = await plans.save(owner.dataDir, identity, plan);
        call.signal.throwIfAborted();
        deps.localInstance.assertReady();
        await call.handle.resolvePath(".", "read");
        const event = { type: "plan.approved", ...identity, planRef };
        await deps.repository.appendEvent(
          scope.instanceId,
          scope.taskId,
          {
            key: `plan-exit:${invocation.runId}/${invocation.toolCallId}`,
            fingerprint: parameterFingerprint({ ...event, plan }),
            event,
          },
          (current) => {
            const { state, snapshot } = requirePendingPlan(
              { ...current, state: structuredClone(current.state) },
              call,
            );
            state.approvedPlan = {
              ...identity,
              planRef,
              approvedAt: Date.now(),
            };
            snapshot.config.planEnabled = false;
            snapshot.seq += 1;
            snapshot.revision += 1;
            return { state, activeRunId: current.active_run_id };
          },
        );
        const { root } = requireActivePlanningRun(
          await deps.repository.find(scope.instanceId, scope.taskId),
          call,
        );
        await deps.refresh(
          scope.instanceId,
          scope.rootDirectory,
          root.project_id,
        );
        await call.handle.resolvePath(".", "read");
        const { snapshot, state } = requireActivePlanningRun(
          await deps.repository.find(scope.instanceId, scope.taskId),
          call,
        );
        if (
          snapshot.config.planEnabled === true ||
          state.approvedPlan?.planRef.planId !== planRef.planId
        )
          throw new Error("批准计划未持久提交，未报告退出成功。");
        const result = {
          approved: true,
          plan,
          mode: snapshot.config.mode,
          planEnabled: false,
          planRef,
        };
        return {
          canonicalOutput: result,
          modelContent: [{ type: "text", text: JSON.stringify(result) }],
        };
      } finally {
        release();
      }
    },
    async enter(context: ToolExecutionContext): Promise<unknown> {
      const call = requirePlanningCall(context, "enter");
      const { scope, invocation } = call;
      await call.handle.resolvePath(".", "read");
      requireActivePlanningRun(
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
          const { state, snapshot } = requireActivePlanningRun(
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
      const { root } = requireActivePlanningRun(
        await deps.repository.find(scope.instanceId, scope.taskId),
        call,
      );
      await deps.refresh(
        scope.instanceId,
        scope.rootDirectory,
        root.project_id,
      );
      await call.handle.resolvePath(".", "read");
      const { snapshot } = requireActivePlanningRun(
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
