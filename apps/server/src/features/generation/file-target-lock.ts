import type { GenerationFileTarget } from "@kenfutwork/shared";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import { GenerationTargetError } from "./file-targets.js";

async function assertTaskOrigin(
  scoped: InstanceSqlClient,
  target: Extract<GenerationFileTarget, { kind: "task" }>,
) {
  if (target.canvasId) {
    const design = await scoped.queryOne<SqlRow>(
      `select d.task_id from public.design_task_executions d
     join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id
       and s.project_id=d.project_id and s.mode='design'
     where d.instance_id=:instance and d.task_id=$1 and d.project_id=$2
       and d.scope_generation=$3 and d.branch_generation=$4
       and d.execution_state='ready' and d.sandbox_mode<>'read-only'
       and s.id=$5 and s.canvas_id=$6 for share of d,s`,
      [
        target.taskId,
        target.projectId,
        target.scopeGeneration,
        target.branchGeneration,
        target.sessionId,
        target.canvasId,
      ],
    );
    if (!design)
      throw new GenerationTargetError("生成任务的原Run授权或画布已失效");
  } else {
    const root = await scoped.queryOne<
      SqlRow & {
        state: {
          inheritedSessions?: Array<{ owner: { sessionId: string } }>;
        } | null;
      }
    >(
      `select state from public.code_ui_sessions where instance_id=:instance and id=$1 and project_id=$2 and parent_session_id is null and deleted_at is null and archived=false and execution_state='ready' and scope_generation=$3 and branch_generation=$4 for share`,
      [
        target.taskId,
        target.projectId,
        target.scopeGeneration,
        target.branchGeneration,
      ],
    );
    if (
      !root ||
      root.state?.inheritedSessions?.some(
        (entry) => entry.owner.sessionId === target.sessionId,
      )
    )
      throw new GenerationTargetError("生成任务的原Run授权或分支已失效");
  }
}

/** Recheck frozen origin under the same transaction that accepts the Job. */
export async function assertGenerationOriginForInsert(
  scoped: InstanceSqlClient,
  target: GenerationFileTarget,
  association?: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
    canvasId?: string | undefined;
  },
) {
  if (target.kind === "standalone") {
    if (
      association?.projectId ||
      association?.sessionId ||
      association?.canvasId
    )
      throw new GenerationTargetError("有关联的任务不能声明独立生成来源");
    return;
  }
  if (association?.projectId && association.projectId !== target.projectId)
    throw new GenerationTargetError("生成任务的项目来源已改变");
  if (association?.sessionId && association.sessionId !== target.sessionId)
    throw new GenerationTargetError("生成任务的会话来源已改变");
  if (target.kind === "task") {
    if (association?.canvasId && association.canvasId !== target.canvasId)
      throw new GenerationTargetError("Code生成任务不能借用画布身份");
    await assertTaskOrigin(scoped, target);
  }
  const project = await scoped.queryOne<SqlRow>(
    `select id from public.projects where instance_id=:instance and id=$1 and archived_at is null and kind ${target.kind === "task" ? (target.canvasId ? "= 'design'" : "= 'code'") : "in ('design','flow')"} for share`,
    [target.projectId],
  );
  if (!project) throw new GenerationTargetError("生成任务的项目不存在或已关闭");
  if (target.sessionId) {
    const session = await scoped.queryOne<SqlRow>(
      `select c.id from public.chat_sessions c join public.projects p on p.id=c.project_id and p.instance_id=c.instance_id where c.instance_id=:instance and c.id=$1 and c.project_id=$2 and c.mode=p.kind for share of c`,
      [target.sessionId, target.projectId],
    );
    if (!session)
      throw new GenerationTargetError("生成任务的原会话已删除或项目不一致");
    if (target.kind === "task" && !target.canvasId) {
      const child = await scoped.queryOne<SqlRow>(
        `select id from public.code_ui_sessions where instance_id=:instance and (id=$1 or chat_session_id=$1) and root_session_id=$2 and deleted_at is null and archived=false for share`,
        [target.sessionId, target.taskId],
      );
      if (!child) throw new GenerationTargetError("生成任务的会话不属于原Task");
    }
  }
  if (target.canvasId) {
    const canvas = await scoped.queryOne<SqlRow>(
      `select c.id from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and c.project_id=$2 and p.instance_id=:instance and p.archived_at is null for share of c`,
      [target.canvasId, target.projectId],
    );
    if (!canvas)
      throw new GenerationTargetError("生成任务的原画布已删除或项目不一致");
  }
}
