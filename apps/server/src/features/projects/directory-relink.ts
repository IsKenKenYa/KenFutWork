import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  ProjectDirectoryRelinkRequest,
  ProjectDirectoryRelinkResponse,
  ProjectDirectoryRelinkSnapshot,
} from "@kenfutwork/shared";
import type { CodeUiConversationState } from "../code-ui/conversation.js";
import { syncGoal } from "../code-ui/goals.js";
import type { FlowProjectControl } from "../flow/project-control.js";
import type { GoalRecord, GoalService } from "../goals/service.js";
import { rebindMissingProjectCheckpoints } from "../local-instance/root-binding.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import { createFlowDirectoryRelink } from "./directory-relink-flow.js";

export class ProjectDirectoryRelinkError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
export interface ProjectDirectoryRelinkService {
  initialize(): Promise<void>;
  snapshot(
    actor: LocalActor,
    projectId: string,
  ): Promise<ProjectDirectoryRelinkSnapshot>;
  relink(
    actor: LocalActor,
    projectId: string,
    input: ProjectDirectoryRelinkRequest,
  ): Promise<ProjectDirectoryRelinkResponse>;
}
type Task = SqlRow & {
  task_id: string;
  kind: "code" | "design";
  root_directory: string;
  scope_generation: number | string;
  branch_generation: number | string;
  execution_state: string;
  active_run_id: string | null;
  state: CodeUiConversationState | null;
  additional_directories: unknown;
  stagedChildren?: { id: string; scope_generation: number | string }[];
};
const conflict = () =>
  new ProjectDirectoryRelinkError("项目或Task已改变，请重新加载后关联。");
async function rootMissing(root: string): Promise<boolean> {
  if (!isAbsolute(root)) throw conflict();
  try {
    await lstat(root);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new ProjectDirectoryRelinkError(
      "旧目录无法确认缺失，请检查目录权限。",
      400,
    );
  }
}
async function missingRoot(root: string) {
  if (!(await rootMissing(root)))
    throw new ProjectDirectoryRelinkError(
      "原项目目录仍存在，不能重新关联。",
      400,
    );
}
async function targetRoot(path: string) {
  if (!isAbsolute(path))
    throw new ProjectDirectoryRelinkError("请选择可访问的绝对目录。", 400);
  const root = await realpath(path).catch(() => {
    throw new ProjectDirectoryRelinkError("新目录不可用，请重新选择。", 400);
  });
  if (!(await lstat(root)).isDirectory())
    throw new ProjectDirectoryRelinkError("请选择实际文件夹。", 400);
  await access(root, constants.R_OK | constants.W_OK | constants.X_OK).catch(
    () => {
      throw new ProjectDirectoryRelinkError("新目录没有读写权限。", 400);
    },
  );
  return root;
}
async function taskRows(sql: InstanceSqlClient, projectId: string) {
  const code = await sql.query<Task>(
    "select id as task_id,'code' as kind,root_directory,additional_directories,scope_generation,branch_generation,execution_state,active_run_id,state from public.code_ui_sessions where instance_id=:instance and project_id=$1 and parent_session_id is null and deleted_at is null for update",
    [projectId],
  );
  const design = await sql.query<Task>(
    "select task_id,'design' as kind,root_directory,additional_directories,scope_generation,branch_generation,execution_state,active_run_id,null as state from public.design_task_executions where instance_id=:instance and project_id=$1 for update",
    [projectId],
  );
  return [...code, ...design].sort((a, b) =>
    a.task_id.localeCompare(b.task_id),
  );
}
function checkTasks(
  rows: Task[],
  input: ProjectDirectoryRelinkRequest,
  delta = 0,
) {
  const fences = new Map(
    input.expectedTasks.map((task) => [task.taskId, task]),
  );
  if (fences.size !== input.expectedTasks.length || fences.size !== rows.length)
    throw conflict();
  for (const row of rows) {
    const fence = fences.get(row.task_id);
    if (
      !fence ||
      row.root_directory !== input.expectedWorkDir ||
      Number(row.scope_generation) !== fence.scopeGeneration + delta ||
      Number(row.branch_generation) !== fence.branchGeneration
    )
      throw conflict();
  }
}
function pausedCodeState(
  state: CodeUiConversationState | null,
  rootId: string,
  goals: GoalService,
) {
  if (!state) return null;
  const next = structuredClone(state);
  for (const input of next.inputs ?? [])
    if (input.status === "queued") input.status = "discarded";
  for (const snapshot of next.snapshots) {
    snapshot.queue.items = [];
    snapshot.queue.autoDrain = false;
  }
  if (next.goalRecord) {
    next.goalRecord = goals.pause(next.goalRecord, {
      goalId: next.goalRecord.goalId,
      revision: next.goalRecord.revision,
      reason: "project.directoryRelink",
      at: Date.now(),
    });
    syncGoal(next, rootId);
  }
  return next;
}
type RelinkDeps = {
  flowProjectControl?: FlowProjectControl;
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
  goals: GoalService;
  closeResources(
    actor: LocalActor,
    taskId: string,
    reason: string,
    kind: "code" | "design",
  ): Promise<void>;
};
async function stageTasks(
  sql: InstanceSqlClient,
  deps: RelinkDeps,
  projectId: string,
  input: ProjectDirectoryRelinkRequest,
  signal: AbortSignal,
) {
  const project = await sql.queryOne<{ work_dir: string | null }>(
    "select work_dir from public.projects where instance_id=:instance and id=$1 and archived_at is null and kind in ('code','design') for update",
    [projectId],
  );
  if (!project || project.work_dir !== input.expectedWorkDir || signal.aborted)
    throw conflict();
  await missingRoot(input.expectedWorkDir);
  const rows = await taskRows(sql, projectId);
  checkTasks(rows, input);
  if (rows.some((row) => row.execution_state === "revoking")) throw conflict();
  const pendingJobs = await sql.queryOne<{ count: string | number }>(
    "select count(*) as count from public.background_jobs where instance_id=:instance and project_id=$1 and status in ('queued','running')",
    [projectId],
  );
  if (Number(pendingJobs?.count ?? 0))
    throw new ProjectDirectoryRelinkError(
      "项目生成任务未结束，请停止后重新关联。",
    );
  for (const row of rows) {
    if (row.kind === "code") {
      await sql.execute(
        "update public.code_ui_sessions set execution_state='revoking',scope_generation=scope_generation+1,state=$2::jsonb,revision=revision+1 where instance_id=:instance and id=$1",
        [
          row.task_id,
          JSON.stringify(pausedCodeState(row.state, row.task_id, deps.goals)),
        ],
      );
      const foreign = await sql.queryOne<{ count: number | string }>(
        "select count(*) as count from public.code_ui_sessions where instance_id=:instance and root_session_id=$1 and project_id<>$2 and deleted_at is null",
        [row.task_id, projectId],
      );
      if (Number(foreign?.count ?? 0)) throw conflict();
      row.stagedChildren = await sql.query<{
        id: string;
        scope_generation: number | string;
      }>(
        "update public.code_ui_sessions set execution_state='revoking',scope_generation=$3 where instance_id=:instance and root_session_id=$1 and id<>$1 and project_id=$2 and deleted_at is null returning id,scope_generation",
        [row.task_id, projectId, Number(row.scope_generation) + 1],
      );
    } else {
      await sql.execute(
        "update public.design_task_executions set execution_state='revoking',scope_generation=scope_generation+1 where instance_id=:instance and task_id=$1",
        [row.task_id],
      );
      await sql.execute(
        "update public.design_task_inputs set status='canceled',request=null where instance_id=:instance and task_id=$1 and status='queued'",
        [row.task_id],
      );
      const goal = await sql.queryOne<{ state: GoalRecord }>(
        "select state from public.design_task_goals where instance_id=:instance and task_id=$1 for update",
        [row.task_id],
      );
      if (goal)
        await sql.execute(
          "update public.design_task_goals set state=$2::jsonb,observed_at=now() where instance_id=:instance and task_id=$1",
          [
            row.task_id,
            JSON.stringify(
              deps.goals.pause(goal.state, {
                goalId: goal.state.goalId,
                revision: goal.state.revision,
                reason: "project.directoryRelink",
                at: Date.now(),
              }),
            ),
          ],
        );
    }
  }
  return rows;
}
async function publishTaskRoot(
  sql: InstanceSqlClient,
  row: Task,
  nextRoot: string,
  goals: GoalService,
  projectId: string,
): Promise<string[]> {
  const additional = remapGrants(
    row.additional_directories,
    row.root_directory,
    nextRoot,
  );
  const branch = Number(row.branch_generation) + 1;
  if (row.kind === "code") {
    const state = row.state ? structuredClone(row.state) : null;
    if (state?.goalRecord) {
      state.goalRecord = goals.rebranch(state.goalRecord, branch, Date.now());
      syncGoal(state, row.task_id);
    }
    const children = await sql.query<{
      id: string;
      additional_directories: unknown;
      root_directory: string;
      scope_generation: number | string;
      execution_state: string;
    }>(
      "select id,additional_directories,root_directory,scope_generation,execution_state from public.code_ui_sessions where instance_id=:instance and root_session_id=$1 and id<>$1 and project_id=$2 and deleted_at is null for update",
      [row.task_id, projectId],
    );
    const expected = new Map(
      (row.stagedChildren ?? []).map((child) => [
        child.id,
        Number(child.scope_generation),
      ]),
    );
    if (
      children.length !== expected.size ||
      children.some(
        (child) =>
          expected.get(child.id) !== Number(child.scope_generation) ||
          child.execution_state !== "revoking" ||
          child.root_directory !== row.root_directory,
      )
    )
      throw conflict();
    const roots = await sql.query<{ id: string }>(
      "update public.code_ui_sessions set root_directory=$2,branch_generation=branch_generation+1,execution_state='ready',state=$3::jsonb,additional_directories=$4::jsonb,revision=revision+1 where instance_id=:instance and id=$1 and deleted_at is null returning id",
      [
        row.task_id,
        nextRoot,
        JSON.stringify(state),
        JSON.stringify(additional),
      ],
    );
    const affected = roots.map((root) => root.id);
    for (const child of children) {
      const changed = await sql.query<{ id: string }>(
        "update public.code_ui_sessions set root_directory=$2,branch_generation=branch_generation+1,execution_state='ready',additional_directories=$3::jsonb,revision=revision+1 where instance_id=:instance and id=$1 returning id",
        [
          child.id,
          nextRoot,
          JSON.stringify(
            remapGrants(
              child.additional_directories,
              row.root_directory,
              nextRoot,
            ),
          ),
        ],
      );
      affected.push(...changed.map((item) => item.id));
    }
    if (affected.length !== children.length + 1) throw conflict();
    return affected;
  }
  const changed = await sql.query<{ task_id: string }>(
    "update public.design_task_executions set root_directory=$2,branch_generation=branch_generation+1,execution_state='ready',additional_directories=$3::jsonb where instance_id=:instance and task_id=$1 returning task_id",
    [row.task_id, nextRoot, JSON.stringify(additional)],
  );
  if (changed.length !== 1) throw conflict();
  const goal = await sql.queryOne<{ state: GoalRecord }>(
    "select state from public.design_task_goals where instance_id=:instance and task_id=$1",
    [row.task_id],
  );
  if (goal)
    await sql.execute(
      "update public.design_task_goals set state=$2::jsonb,observed_at=now() where instance_id=:instance and task_id=$1",
      [
        row.task_id,
        JSON.stringify(goals.rebranch(goal.state, branch, Date.now())),
      ],
    );
  return changed.map((item) => item.task_id);
}
function remapGrants(value: unknown, previousRoot: string, nextRoot: string) {
  if (!Array.isArray(value)) throw conflict();
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string"
    )
      throw conflict();
    const suffix = relative(previousRoot, entry.path);
    return {
      ...entry,
      path:
        isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)
          ? entry.path
          : join(nextRoot, suffix),
    };
  });
}
async function publishDirectory(
  sql: InstanceSqlClient,
  deps: RelinkDeps,
  projectId: string,
  input: ProjectDirectoryRelinkRequest,
  nextRoot: string,
  dataDir: string,
  signal: AbortSignal,
  setRollback: (rollback: () => Promise<void>) => void,
  staged: Task[],
): Promise<ProjectDirectoryRelinkResponse> {
  const project = await sql.queryOne<{
    work_dir: string | null;
    additional_directories: unknown;
  }>(
    "select work_dir,additional_directories from public.projects where instance_id=:instance and id=$1 and archived_at is null and kind in ('code','design') for update",
    [projectId],
  );
  if (!project || project.work_dir !== input.expectedWorkDir || signal.aborted)
    throw conflict();
  await missingRoot(input.expectedWorkDir);
  if ((await targetRoot(input.nextWorkDir)) !== nextRoot) throw conflict();
  const rows = await taskRows(sql, projectId);
  checkTasks(rows, input, 1);
  if (
    rows.some((row) => row.execution_state !== "revoking" || row.active_run_id)
  )
    throw new ProjectDirectoryRelinkError("真实Task尚未停止，目录保持关闭。");
  const activeChildren = await sql.queryOne<{ count: string | number }>(
    "select count(*) as count from public.code_ui_sessions where instance_id=:instance and project_id=$1 and parent_session_id is not null and deleted_at is null and active_run_id is not null",
    [projectId],
  );
  if (Number(activeChildren?.count ?? 0))
    throw new ProjectDirectoryRelinkError("子任务尚未真实停止，目录保持关闭。");
  const canvases = await sql.query<{
    id: string;
    root_directory: string | null;
  }>(
    "select c.id,c.root_directory from public.canvases c join public.projects p on p.id=c.project_id where p.instance_id=:instance and p.id=$1 for update of c",
    [projectId],
  );
  if (
    canvases.some(
      (row) =>
        row.root_directory && row.root_directory !== input.expectedWorkDir,
    )
  )
    throw conflict();
  const rollback = await rebindMissingProjectCheckpoints({
    scoped: sql,
    projectId,
    dataDir,
    previousRoot: input.expectedWorkDir,
    nextRoot,
  });
  setRollback(rollback);
  await sql.execute(
    "update public.projects set work_dir=$2,additional_directories=$4::jsonb where instance_id=:instance and id=$1 and work_dir=$3",
    [
      projectId,
      nextRoot,
      input.expectedWorkDir,
      JSON.stringify(
        remapGrants(
          project.additional_directories,
          input.expectedWorkDir,
          nextRoot,
        ),
      ),
    ],
  );
  await sql.execute(
    "update public.canvases c set root_directory=$2 from public.projects p where c.project_id=p.id and p.id=$1 and p.instance_id=:instance",
    [projectId, nextRoot],
  );
  const affectedTaskIds: string[] = [];
  for (const row of rows) {
    const original = staged.find((task) => task.task_id === row.task_id);
    if (original?.stagedChildren) row.stagedChildren = original.stagedChildren;
    affectedTaskIds.push(
      ...(await publishTaskRoot(sql, row, nextRoot, deps.goals, projectId)),
    );
  }
  return {
    projectId,
    workDir: nextRoot,
    affectedTaskIds,
    tasks: rows.map((row) => ({
      taskId: row.task_id,
      scopeGeneration: Number(row.scope_generation),
      branchGeneration: Number(row.branch_generation) + 1,
      status: "ready" as const,
    })),
  };
}
async function readSnapshot(
  deps: RelinkDeps,
  actor: LocalActor,
  projectId: string,
): Promise<ProjectDirectoryRelinkSnapshot> {
  await deps.localInstance.resolve(actor);
  if (!actor.accessClientId)
    throw new ProjectDirectoryRelinkError(
      "重新关联需要已授权的接入客户端。",
      403,
    );
  return deps.persistence.transaction(async (tx) => {
    const sql = tx.forInstance(actor.instanceId);
    const project = await sql.queryOne<{ work_dir: string | null }>(
      "select work_dir from public.projects where instance_id=:instance and id=$1 and archived_at is null and kind in ('code','design') for share",
      [projectId],
    );
    if (!project?.work_dir) throw conflict();
    await missingRoot(project.work_dir);
    const rows = await taskRows(sql, projectId);
    if (rows.some((row) => row.root_directory !== project.work_dir))
      throw new ProjectDirectoryRelinkError(
        "历史Task目录不一致，请先显式迁移。",
      );
    return {
      projectId,
      workDir: project.work_dir,
      tasks: rows.map((row) => ({
        taskId: row.task_id,
        scopeGeneration: Number(row.scope_generation),
        branchGeneration: Number(row.branch_generation),
      })),
    };
  });
}
export function createProjectDirectoryRelinkService(
  deps: RelinkDeps,
): ProjectDirectoryRelinkService {
  const flow = createFlowDirectoryRelink({
    persistence: deps.persistence,
    localInstance: deps.localInstance,
    ...(deps.flowProjectControl
      ? { flowProjectControl: deps.flowProjectControl }
      : {}),
    missingRoot,
    rootMissing,
    targetRoot,
    taskRows,
    error: (message, statusCode) =>
      new ProjectDirectoryRelinkError(message, statusCode),
  });
  return {
    initialize: flow.initialize,
    async snapshot(actor, projectId) {
      const kind = await flow.projectKind(actor, projectId);
      return kind === "flow"
        ? flow.snapshot(actor, projectId)
        : readSnapshot(deps, actor, projectId);
    },
    async relink(actor, projectId, input) {
      const kind = await flow.projectKind(actor, projectId);
      if (kind === "flow") return flow.relink(actor, projectId, input);
      if (input.expectedFlow) throw conflict();
      const context = await deps.localInstance.resolve(actor);
      if (!actor.accessClientId)
        throw new ProjectDirectoryRelinkError(
          "重新关联需要已授权的接入客户端。",
          403,
        );
      await missingRoot(input.expectedWorkDir);
      const nextRoot = await targetRoot(input.nextWorkDir);
      if (deps.localInstance.isDraining())
        throw new ProjectDirectoryRelinkError("实例正在维护，请稍后重试。");
      const lock = await deps.persistence.acquireSessionLock(
        `project-directory-relink:${actor.instanceId}:${projectId}`,
      );
      if (!lock) throw conflict();
      let rollbackCheckpoints: (() => Promise<void>) | undefined;
      let maintenanceOwned = false;
      let staged: Task[] = [];
      try {
        if (deps.localInstance.isDraining())
          throw new ProjectDirectoryRelinkError("实例正在维护，请稍后重试。");
        maintenanceOwned = true;
        await deps.localInstance.beginMaintenance(async () => {
          if (deps.localInstance.activeAdmissionCount())
            throw new ProjectDirectoryRelinkError(
              "任务正在接受输入，请稍后重试。",
            );
        });
        staged = await deps.persistence.transaction((tx) =>
          stageTasks(
            tx.forInstance(actor.instanceId),
            deps,
            projectId,
            input,
            lock.signal,
          ),
        );
        for (const task of staged)
          await deps.closeResources(
            actor,
            task.task_id,
            "项目目录重新关联",
            task.kind,
          );
        return await deps.persistence.transaction((tx) =>
          publishDirectory(
            tx.forInstance(actor.instanceId),
            deps,
            projectId,
            input,
            nextRoot,
            context.dataDir,
            lock.signal,
            (rollback) => {
              rollbackCheckpoints = rollback;
            },
            staged,
          ),
        );
      } catch (error) {
        await rollbackCheckpoints?.();
        for (const task of staged) {
          const table =
            task.kind === "code"
              ? "code_ui_sessions"
              : "design_task_executions";
          const key = task.kind === "code" ? "id" : "task_id";
          await deps.persistence
            .forInstance(actor.instanceId)
            .execute(
              `update public.${table} set execution_state='failed' where instance_id=:instance and ${key}=$1 and scope_generation=$2 and execution_state='revoking'`,
              [task.task_id, Number(task.scope_generation) + 1],
            );
        }
        throw error;
      } finally {
        if (maintenanceOwned) deps.localInstance.cancelMaintenance();
        await lock.release();
      }
    },
  };
}
