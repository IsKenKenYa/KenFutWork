import {
  type BackgroundJob,
  type GenerationFileTarget,
  generationFileTargetSchema,
} from "@kenfutwork/shared";
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
  expectedScopeGeneration?: number | undefined;
  expectedBranchGeneration?: number | undefined;
}
export interface GenerationTargets {
  prepareOrigin(input: GenerationOrigin): Promise<GenerationFileTarget>;
  resolve(job: BackgroundJob): Promise<ProjectFileTarget | null>;
}
type Binding = SqlRow & {
  project_id: string;
  kind: "design" | "code" | "flow";
  mode?: string;
  canvas_id?: string | null;
};
type Root = SqlRow & {
  id: string;
  project_id: string;
  root_directory: string;
  scope_generation: number | string;
  branch_generation: number | string;
  state: { inheritedSessions?: Array<{ owner: { sessionId: string } }> } | null;
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
      `select c.project_id, c.mode, c.canvas_id, p.kind from public.chat_sessions c join public.projects p on p.id=c.project_id and p.instance_id=c.instance_id where c.instance_id=:instance and c.id=$1 and p.archived_at is null`,
      [input.sessionId],
    );
    if (
      !row ||
      row.mode !== row.kind ||
      (input.projectId && input.projectId !== row.project_id) ||
      (input.canvasId && input.canvasId !== row.canvas_id)
    )
      throw new GenerationTargetError("生成任务的会话与项目归属不一致或已关闭");
    return row;
  }
  if (input.projectId) {
    const row = await scoped.queryOne<Binding>(
      `select id as project_id, kind from public.projects where instance_id=:instance and id=$1 and archived_at is null`,
      [input.projectId],
    );
    if (!row) throw new GenerationTargetError("生成任务的项目不存在或已关闭");
    if (input.canvasId) {
      const canvas = await scoped.queryOne<SqlRow & { project_id: string }>(
        `select c.project_id from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and p.instance_id=:instance and p.archived_at is null`,
        [input.canvasId],
      );
      if (canvas?.project_id !== row.project_id)
        throw new GenerationTargetError("生成任务的画布与项目不一致");
    }
    return row;
  }
  const row = await scoped.queryOne<Binding>(
    `select p.id as project_id, p.kind from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and p.instance_id=:instance and p.archived_at is null and p.kind in ('design','flow')`,
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
    throw new GenerationTargetError(
      "Code生成任务的工作域不存在或会话为只读历史",
    );
  return root;
}
async function designRoot(
  persistence: PersistenceService,
  input: GenerationOrigin,
  target: Binding,
): Promise<Root> {
  const root = await persistence
    .forInstance(input.actor.instanceId)
    .queryOne<Root>(
      `select d.task_id as id, d.project_id, d.root_directory,
        d.scope_generation, d.branch_generation, null::jsonb as state
       from public.design_task_executions d
       join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id
         and s.project_id=d.project_id and s.mode='design'
       where d.instance_id=:instance and d.task_id=$1 and d.project_id=$2
         and s.canvas_id=$3 and d.execution_state='ready'`,
      [input.sessionId, target.project_id, target.canvas_id],
    );
  if (!root)
    throw new GenerationTargetError(
      "Design生成任务尚未绑定可用Task，请重新准备会话",
    );
  return root;
}
type TargetDeps = {
  persistence: PersistenceService;
  executionScopes: Pick<ExecutionScopes, "openTask">;
};
async function prepareOrigin(
  deps: TargetDeps,
  input: GenerationOrigin,
): Promise<GenerationFileTarget> {
  if (input.interactiveRequest && !input.actor.accessClientId)
    throw new GenerationTargetError("交互式生成需要已授权的接入客户端");
  if (!input.projectId && !input.sessionId && !input.canvasId)
    return { kind: "standalone" };
  const target = await binding(deps.persistence, input);
  if (target.kind !== "code" && !(target.kind === "design" && input.sessionId))
    return {
      kind: "project",
      projectId: target.project_id,
      sessionId: input.sessionId ?? null,
      canvasId: input.canvasId ?? null,
    };
  if (!input.sessionId || (target.kind === "code" && input.canvasId))
    throw new GenerationTargetError(
      "Code生成任务必须绑定真实Task会话，不能借用画布",
    );
  const root =
    target.kind === "design"
      ? await designRoot(deps.persistence, input, target)
      : await codeRoot(deps.persistence, input, target.project_id);
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
    handle.preset !== target.kind ||
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
    ...(target.kind === "design" && target.canvas_id
      ? { canvasId: target.canvas_id }
      : {}),
    scopeGeneration,
    branchGeneration,
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
  const current = await prepareOrigin(deps, {
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
        }
      : {}),
  });
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
    prepareOrigin: (input) => prepareOrigin(deps, input),
    resolve: (job) => resolveFrozen(deps, job),
  };
}
