import {
  canvasContentSchema,
  type GenerationFileTarget,
} from "@kenfutwork/shared";
import {
  CanvasFileStoreError,
  createCanvasFileStore,
} from "../canvas/file-store.js";
import type { CodeUiConversationState } from "../code-ui/conversation.js";
import { codeUiRunOutcome } from "../code-ui/run-outcome.js";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import { validateWorkDir } from "../projects/work-dir.js";
import { GenerationTargetError } from "./file-targets.js";

type GeneratorCanvas = SqlRow & {
  content: unknown;
  root_directory: string | null;
  work_dir: string | null;
};

async function assertCanvasGenerator(
  canvas: GeneratorCanvas,
  canvasId: string,
  generatorId: string,
  jobType: string | undefined,
) {
  let content = canvas.content;
  const indexed =
    (content as { storage?: unknown } | null)?.storage === "project-files";
  if (indexed && !canvas.root_directory)
    throw new GenerationTargetError("画布目录缺失，请重新关联项目目录");
  if (canvas.root_directory) {
    // 与CanvasService.claimRoot一致：只读服务端冻结根，显式项目根不可分叉。
    if (canvas.work_dir && canvas.work_dir !== canvas.root_directory)
      throw new GenerationTargetError("画布目录已改变，请重新关联项目目录");
    const directory = validateWorkDir(canvas.root_directory);
    if (!directory.ok || directory.path !== canvas.root_directory)
      throw new GenerationTargetError("画布目录不可用，请重新关联项目目录");
    try {
      const snapshot = await createCanvasFileStore({
        projectRoot: canvas.root_directory,
      }).read(canvasId);
      if (!snapshot && indexed)
        throw new GenerationTargetError("画布文件缺失，请恢复后重试");
      // 文件写入与索引标记之间若曾中断，仍按CanvasService.load优先读已存文件。
      content = snapshot?.content ?? content;
    } catch (error) {
      if (error instanceof CanvasFileStoreError)
        throw new GenerationTargetError(error.message);
      throw error;
    }
  }
  const parsed = canvasContentSchema.safeParse(content ?? {});
  if (!parsed.success)
    throw new GenerationTargetError("画布内容无效，请重新加载后重试");
  const expectedType =
    jobType === "image_generation"
      ? "image-generator"
      : jobType === "video_generation"
        ? "video-generator"
        : null;
  const generator = parsed.data.elements.find(
    (element) => element.id === generatorId && !element.isDeleted,
  );
  if (
    !expectedType ||
    (generator?.customData as { type?: unknown } | undefined)?.type !==
      expectedType
  )
    throw new GenerationTargetError("生成器已删除或类型不匹配，请重新选择");
}

async function assertTaskOrigin(
  scoped: InstanceSqlClient,
  target: Extract<GenerationFileTarget, { kind: "task" }>,
) {
  const root = await scoped.queryOne<
    SqlRow & {
      state: CodeUiConversationState | null;
    }
  >(
    `select state from public.code_ui_sessions where instance_id=:instance and id=$1 and project_id=$2
       and parent_session_id is null and deleted_at is null and archived=false and execution_state='ready'
       and scope_generation=$3 and branch_generation=$4 and sandbox_mode<>'read-only' for share`,
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
  if (
    target.originRunId === undefined ||
    (target.originRunId !== null &&
      codeUiRunOutcome(root.state, target.originRunId) !== "active")
  )
    throw new GenerationTargetError(
      "生成任务的原Run已停止或来源缺失，请重新提交",
    );
}

/** Recheck frozen origin under the same transaction that accepts the Job. */
export async function assertGenerationOriginForInsert(
  scoped: InstanceSqlClient,
  target: GenerationFileTarget,
  association?: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
    canvasId?: string | undefined;
    jobType?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  },
) {
  const generatorId = association?.payload?.generator_id;
  if (
    generatorId !== undefined &&
    (typeof generatorId !== "string" ||
      !generatorId ||
      target.kind === "standalone" ||
      !target.canvasId)
  )
    throw new GenerationTargetError("生成器必须绑定当前画布，请重新选择");
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
      throw new GenerationTargetError("生成任务的画布来源已改变");
    await assertTaskOrigin(scoped, target);
  }
  const project = await scoped.queryOne<SqlRow>(
    `select id from public.projects where instance_id=:instance and id=$1 and archived_at is null for share`,
    [target.projectId],
  );
  if (!project) throw new GenerationTargetError("生成任务的项目不存在或已关闭");
  if (target.sessionId) {
    const session = await scoped.queryOne<SqlRow>(
      `select c.id from public.chat_sessions c join public.projects p on p.id=c.project_id and p.instance_id=c.instance_id where c.instance_id=:instance and c.id=$1 and c.project_id=$2 for share of c`,
      [target.sessionId, target.projectId],
    );
    if (!session)
      throw new GenerationTargetError("生成任务的原会话已删除或项目不一致");
    if (target.kind === "task") {
      const child = await scoped.queryOne<SqlRow>(
        `select id from public.code_ui_sessions where instance_id=:instance and (id=$1 or chat_session_id=$1) and root_session_id=$2 and deleted_at is null and archived=false for share`,
        [target.sessionId, target.taskId],
      );
      if (!child) throw new GenerationTargetError("生成任务的会话不属于原Task");
    }
  }
  if (target.canvasId) {
    if (generatorId !== undefined)
      await scoped.execute(
        `select pg_advisory_xact_lock(hashtextextended('canvas-document:' || :instance || ':' || $1,0))`,
        [target.canvasId],
      );
    const canvas = await scoped.queryOne<GeneratorCanvas>(
      `select c.id,c.content,c.root_directory,p.work_dir from public.canvases c join public.projects p on p.id=c.project_id where c.id=$1 and c.project_id=$2 and p.instance_id=:instance and p.archived_at is null and c.deleted_at is null and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes)) for share of c`,
      [target.canvasId, target.projectId],
    );
    if (!canvas)
      throw new GenerationTargetError("生成任务的原画布已删除或项目不一致");
    if (typeof generatorId === "string")
      await assertCanvasGenerator(
        canvas,
        target.canvasId,
        generatorId,
        association?.jobType,
      );
  }
}
