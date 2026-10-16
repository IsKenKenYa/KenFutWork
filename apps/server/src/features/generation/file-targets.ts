import { isDeepStrictEqual } from "node:util";
import {
  type BackgroundJob,
  type GenerationFileTarget,
  generationFileTargetSchema,
} from "@kenfutwork/shared";
import type { CodeUiConversationState } from "../code-ui/conversation.js";
import {
  codeUiRunHasStopIntent,
  codeUiRunOutcome,
  codeUiRunStoppedByHost,
} from "../code-ui/run-outcome.js";
import type { ExecutionScopes } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import type { ProjectFileTarget } from "../project-files/types.js";
export interface GenerationOrigin {
  actor: LocalActor;
  interactiveRequest?: true | undefined;
  projectId?: string | undefined;
  sessionId?: string | undefined;
  canvasId?: string | undefined;
  runId?: string | undefined;
  expectedScopeGeneration?: number | undefined;
  expectedBranchGeneration?: number | undefined;
}
export interface GenerationTargets {
  /** 锁顺序：原Task行→原Job行→文档锁；最终发布之前不释放来源屏障。 */
  withOriginLock<T>(
    job: BackgroundJob,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  prepareOrigin(input: GenerationOrigin): Promise<GenerationFileTarget>;
  resolve(job: BackgroundJob): Promise<ProjectFileTarget | null>;
}
type Binding = SqlRow & {
  project_id: string;
  enabled_modes: Array<"code" | "design" | "flow">;
};
type Root = SqlRow & {
  id: string;
  project_id: string;
  root_directory: string;
  scope_generation: number | string;
  branch_generation: number | string;
  state: CodeUiConversationState | null;
};
export class GenerationTargetError extends Error {
  readonly code = "invalid_input";
  readonly statusCode = 409;
}
async function binding(
  persistence: PersistenceService,
  input: GenerationOrigin,
): Promise<Binding> {
  const scoped = persistence.forInstance(input.actor.instanceId);
  if (input.sessionId) {
    const row = await scoped.queryOne<Binding>(
      `select c.project_id, p.enabled_modes from public.chat_sessions c join public.projects p on p.id=c.project_id and p.instance_id=c.instance_id where c.instance_id=:instance and c.id=$1 and p.archived_at is null`,
      [input.sessionId],
    );
    if (!row || (input.projectId && input.projectId !== row.project_id))
      throw new GenerationTargetError("生成任务的会话与项目归属不一致或已关闭");
    return row;
  }
  if (input.projectId) {
    const row = await scoped.queryOne<Binding>(
      `select id as project_id, enabled_modes from public.projects where instance_id=:instance and id=$1 and archived_at is null`,
      [input.projectId],
    );
    if (!row) throw new GenerationTargetError("生成任务的项目不存在或已关闭");
    if (input.canvasId) {
      const canvas = await scoped.queryOne<SqlRow & { project_id: string }>(
        `select c.project_id from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and p.instance_id=:instance and p.archived_at is null and c.deleted_at is null`,
        [input.canvasId],
      );
      if (canvas?.project_id !== row.project_id)
        throw new GenerationTargetError("生成任务的画布与项目不一致");
    }
    return row;
  }
  const row = await scoped.queryOne<Binding>(
    `select p.id as project_id, p.enabled_modes from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and p.instance_id=:instance and p.archived_at is null and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes)) and c.deleted_at is null`,
    [input.canvasId],
  );
  if (!row) throw new GenerationTargetError("生成任务缺少可验证的项目归属");
  return row;
}
async function codeRoot(
  persistence: PersistenceService,
  input: GenerationOrigin,
  projectId: string,
): Promise<Root> {
  const root = await persistence
    .forInstance(input.actor.instanceId)
    .queryOne<Root>(
      `select root.id, root.project_id, root.root_directory, root.state, root.scope_generation, root.branch_generation from public.code_ui_sessions child join public.code_ui_sessions root on root.id=child.root_session_id and root.instance_id=child.instance_id where child.instance_id=:instance and (child.id=$1 or child.chat_session_id=$1) and child.deleted_at is null and child.archived=false and root.project_id=$2 and root.parent_session_id is null and root.deleted_at is null and root.archived=false and root.execution_state='ready'`,
      [input.sessionId, projectId],
    );
  if (
    !root ||
    root.state?.inheritedSessions?.some(
      (entry) => entry.owner.sessionId === input.sessionId,
    )
  )
    throw new GenerationTargetError("生成任务的工作域不存在或会话为只读历史");
  return root;
}
type TargetDeps = {
  persistence: PersistenceService;
  executionScopes: Pick<ExecutionScopes, "openTask">;
};
async function prepareOrigin(
  deps: TargetDeps,
  input: GenerationOrigin,
  storedInteractive = false,
  acceptedProviderHandle = false,
): Promise<GenerationFileTarget> {
  if (input.interactiveRequest && !input.actor.accessClientId)
    throw new GenerationTargetError("交互式生成需要已授权的接入客户端");
  if (!input.projectId && !input.sessionId && !input.canvasId)
    return { kind: "standalone" };
  const target = await binding(deps.persistence, input);
  if (input.canvasId) {
    const canvas = await deps.persistence
      .forInstance(input.actor.instanceId)
      .queryOne<SqlRow>(
        `select c.id from public.canvases c join public.projects p on p.id=c.project_id
       where c.id=$1 and c.project_id=$2 and p.instance_id=:instance
         and c.deleted_at is null and p.archived_at is null
         and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes))`,
        [input.canvasId, target.project_id],
      );
    if (!canvas)
      throw new GenerationTargetError("生成任务的画布已删除或不属于当前项目");
  }
  if (!input.sessionId || target.enabled_modes.includes("flow")) {
    if (target.enabled_modes.every((mode) => mode === "code"))
      throw new GenerationTargetError("生成任务必须绑定真实Task会话");
    return {
      kind: "project",
      projectId: target.project_id,
      sessionId: input.sessionId ?? null,
      canvasId: input.canvasId ?? null,
    };
  }
  const root = await codeRoot(deps.persistence, input, target.project_id);
  if (!input.runId && !input.interactiveRequest && !storedInteractive)
    throw new GenerationTargetError("生成任务缺少原Run身份，请重新提交");
  if (input.runId) {
    const outcome = codeUiRunOutcome(root.state, input.runId);
    if (
      codeUiRunHasStopIntent(root.state, input.runId) ||
      (outcome !== "active" &&
        !(storedInteractive && outcome === "completed") &&
        !(
          storedInteractive &&
          acceptedProviderHandle &&
          codeUiRunStoppedByHost(root.state, input.runId)
        ))
    )
      throw new GenerationTargetError(
        "生成任务的原Run已停止或状态不可验证，请重新提交",
      );
  }
  const scopeGeneration = input.interactiveRequest
    ? Number(root.scope_generation)
    : input.expectedScopeGeneration;
  const branchGeneration = input.interactiveRequest
    ? Number(root.branch_generation)
    : input.expectedBranchGeneration;
  if (
    scopeGeneration === undefined ||
    branchGeneration === undefined ||
    Number(root.scope_generation) !== scopeGeneration ||
    Number(root.branch_generation) !== branchGeneration
  )
    throw new GenerationTargetError(
      "生成任务的原Run授权代际已失效，请重新提交",
    );
  const handle = await deps.executionScopes.openTask(input.actor, root.id);
  const scope = handle.describe();
  if (
    scope.instanceId !== input.actor.instanceId ||
    scope.taskId !== root.id ||
    handle.preset !== "code" ||
    handle.branchGeneration !== branchGeneration ||
    scope.projectId !== target.project_id ||
    scope.rootDirectory !== root.root_directory ||
    scope.generation !== scopeGeneration
  )
    throw new GenerationTargetError("生成任务与固定工作目录不一致");
  if (scope.sandboxMode === "read-only")
    throw new GenerationTargetError(
      "任务目录只读，不能保存生成文件，请修改目录授权",
    );
  await handle.resolvePath(".", "write");
  return {
    kind: "task",
    taskId: root.id,
    projectId: target.project_id,
    sessionId: input.sessionId,
    ...(input.canvasId ? { canvasId: input.canvasId } : {}),
    scopeGeneration,
    branchGeneration,
    originRunId: input.runId ?? null,
  };
}
async function resolveFrozen(
  deps: TargetDeps,
  job: BackgroundJob,
): Promise<ProjectFileTarget | null> {
  if (!job.file_target)
    throw new GenerationTargetError(
      "生成任务缺少已验证文件来源，请重新提交生成",
    );
  const target = generationFileTargetSchema.parse(job.file_target);
  if (target.kind === "standalone") {
    if (job.project_id || job.session_id || job.canvas_id)
      throw new GenerationTargetError("有关联的生成任务不能退回独立文件存储");
    return null;
  }
  if (
    (job.project_id && job.project_id !== target.projectId) ||
    (job.session_id && job.session_id !== target.sessionId) ||
    (job.canvas_id && job.canvas_id !== target.canvasId)
  )
    throw new GenerationTargetError("生成任务当前关联与已保存来源不一致");
  const current = await prepareOrigin(
    deps,
    {
      actor: {
        instanceId: job.instance_id,
        accessClientId: job.created_by_client_id,
      },
      projectId: target.projectId,
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.canvasId ? { canvasId: target.canvasId } : {}),
      ...(target.kind === "task"
        ? {
            expectedScopeGeneration: target.scopeGeneration,
            expectedBranchGeneration: target.branchGeneration,
            ...(target.originRunId ? { runId: target.originRunId } : {}),
          }
        : {}),
    },
    true,
    Boolean(job.provider_job_id),
  );
  if (target.kind === "task" && target.originRunId === undefined)
    throw new GenerationTargetError("生成任务缺少冻结原Run来源，请重新提交");
  if (
    current.kind !== target.kind ||
    (target.kind === "task" &&
      (current.kind !== "task" || current.taskId !== target.taskId))
  )
    throw new GenerationTargetError("生成任务的文件来源已改变");
  return target.kind === "task"
    ? { kind: "task", taskId: target.taskId }
    : target.canvasId
      ? {
          kind: "canvas",
          projectId: target.projectId,
          canvasId: target.canvasId,
        }
      : { kind: "project", projectId: target.projectId };
}
export function createGenerationTargets(deps: TargetDeps): GenerationTargets {
  return {
    withOriginLock: (job, operation) =>
      deps.persistence.withSessionTransaction(async (tx, signal) => {
        const target = generationFileTargetSchema.parse(job.file_target);
        const sql = tx.forInstance(job.instance_id);
        if (target.kind === "task") {
          const root = await sql.queryOne(
            `select id from public.code_ui_sessions where instance_id=:instance and id=$1 for share`,
            [target.taskId],
          );
          if (!root) throw new GenerationTargetError("生成任务的原Task已删除");
        }
        const current = await sql.queryOne<
          SqlRow & { status: string; file_target: unknown }
        >(
          `select status,file_target from public.background_jobs where instance_id=:instance and id=$1 for share`,
          [job.id],
        );
        if (
          !current ||
          !["running", "succeeded"].includes(current.status) ||
          !isDeepStrictEqual(
            generationFileTargetSchema.parse(current.file_target),
            target,
          )
        )
          throw new GenerationTargetError("生成任务已停止或原来源已改变");
        await resolveFrozen(deps, job);
        signal.throwIfAborted();
        return operation(signal);
      }),
    prepareOrigin: (input) => prepareOrigin(deps, input),
    resolve: (job) => resolveFrozen(deps, job),
  };
}
