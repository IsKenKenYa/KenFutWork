import { z } from "zod";
import type { PromptExecutionContext } from "../../kernel/types.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { CodeApprovedPlanStore } from "./approved-plan-store.js";
import {
  type CodeApprovedPlan,
  codePlanApprovalIdentity,
} from "./planning-types.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

export interface CodeApprovedPlanContent {
  fact: CodeApprovedPlan;
  plan: string;
}
export interface CodeApprovedPlanReader {
  read(
    context: PromptExecutionContext,
  ): Promise<CodeApprovedPlanContent | null>;
}

const approvedPlanSchema = z
  .object({
    instanceId: z.string().min(1),
    taskId: z.uuid(),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
    agentId: z.literal("main"),
    role: z.literal("main"),
    scopeGeneration: z.number().int().nonnegative(),
    branchGeneration: z.number().int().nonnegative(),
    planningEpoch: z.number().int().nonnegative(),
    approvedAt: z.number().int().nonnegative(),
    planRef: z.object({
      planId: z.string().min(1),
      relativePath: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  })
  .passthrough();

function requirePlanReaderContext(context: PromptExecutionContext) {
  const {
    actor,
    scopeHandle: handle,
    taskWorkContext: work,
    runId,
    signal,
  } = context;
  const scope = handle?.describe();
  if (
    !actor ||
    !handle ||
    !work ||
    !runId ||
    !signal ||
    !scope ||
    actor.instanceId !== scope.instanceId ||
    work.actor?.instanceId !== scope.instanceId ||
    work.scope.instanceId !== scope.instanceId ||
    work.scope.taskId !== scope.taskId ||
    work.scope.rootDirectory !== scope.rootDirectory ||
    work.scope.generation !== scope.generation ||
    work.agentId !== handle.agentId ||
    work.runId !== runId
  )
    throw new Error("批准计划读取缺少真实Run/Actor/Task工作域绑定。");
  signal.throwIfAborted();
  work.signal?.throwIfAborted();
  return { actor, handle, work, runId, signal, scope };
}

function requireCurrentTask(
  root: CodeUiSessionRecord | null,
  call: ReturnType<typeof requirePlanReaderContext>,
) {
  call.signal.throwIfAborted();
  call.work.signal?.throwIfAborted();
  if (
    !root?.state ||
    root.id !== call.scope.taskId ||
    root.instance_id !== call.scope.instanceId ||
    root.parent_session_id !== null ||
    root.root_session_id !== root.id ||
    root.deleted_at ||
    root.archived ||
    root.execution_state !== "ready" ||
    root.root_directory !== call.scope.rootDirectory ||
    Number(root.scope_generation) !== call.scope.generation ||
    Number(root.branch_generation) !== call.work.branchGeneration ||
    (call.handle.role === "main" && root.active_run_id !== call.runId)
  )
    throw new Error("批准计划读取所属Task、Run或授权分支已失效。");
  return { root, state: root.state };
}

/** Provider：批准事务事实与受管理文件重新核验，独立于native转录与摘要。 */
export function createCodeApprovedPlanReader(deps: {
  repository: CodeUiRepository;
  localInstance: LocalInstanceService;
  settings: SettingsService;
  files: CodeApprovedPlanStore;
}): CodeApprovedPlanReader {
  return {
    async read(context) {
      const call = requirePlanReaderContext(context);
      await call.handle.resolvePath(".", "read");
      const { state } = requireCurrentTask(
        await deps.repository.find(call.scope.instanceId, call.scope.taskId),
        call,
      );
      if (!state.approvedPlan) return null;
      const fact = approvedPlanSchema.parse(state.approvedPlan);
      if (
        fact.instanceId !== call.scope.instanceId ||
        fact.taskId !== call.scope.taskId
      )
        throw new Error("批准计划不属于当前实例或Task。");
      // 分支已更换时旧批准保留为历史事实；当前执行权限永远由实际Scope持有。
      if (fact.branchGeneration !== call.work.branchGeneration) return null;
      const identity = codePlanApprovalIdentity(fact);
      const proof = await deps.repository.readApprovedPlanProof(
        fact.instanceId,
        fact.taskId,
        fact.runId,
        fact.toolCallId,
      );
      const event = {
        type: "plan.approved",
        ...identity,
        planRef: fact.planRef,
      };
      if (
        !proof ||
        parameterFingerprint(proof.event) !== parameterFingerprint(event)
      )
        throw new Error("批准计划缺少匹配的Task事务来源。");
      const owner = await deps.localInstance.resolve(call.actor);
      const limits = await deps.settings.getInstanceSettings(
        call.actor,
        owner.instanceId,
      );
      const plan = await deps.files.read(
        owner.dataDir,
        identity,
        fact.planRef,
        { maxBytes: limits.codeReadMaxBytes, signal: call.signal },
      );
      if (proof.fingerprint !== parameterFingerprint({ ...event, plan }))
        throw new Error("批准计划正文与原批准事务指纹不一致。");
      const after = requireCurrentTask(
        await deps.repository.find(call.scope.instanceId, call.scope.taskId),
        call,
      );
      if (
        parameterFingerprint(after.state.approvedPlan) !==
        parameterFingerprint(fact)
      )
        throw new Error("读取期间批准计划已改变，未发布旧上下文。");
      await call.handle.resolvePath(".", "read");
      call.signal.throwIfAborted();
      return { fact, plan };
    },
  };
}
