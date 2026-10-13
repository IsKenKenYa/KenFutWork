import type { AdditionalDirectory, SandboxMode } from "@kenfutwork/shared";
import { claimCanvasRootInTransaction } from "../canvas/root-directory.js";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import { DesignTaskError } from "./design-task-errors.js";
import type {
  DesignTaskPolicy,
  DesignTaskPreparation,
} from "./design-task-types.js";
import { parameterFingerprint } from "./parameter-fingerprint.js";

export type DesignProjectRow = SqlRow & {
  project_id: string;
  canvas_id: string;
  kind: string;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
  canvas_root_directory?: string;
};

export type DesignTaskRow = SqlRow & {
  task_id: string;
  project_id: string;
  canvas_id: string;
  root_directory: string;
  additional_directories: AdditionalDirectory[];
  sandbox_mode: SandboxMode;
  scope_generation: number | string;
  branch_generation: number | string;
  permission_mode: "build" | "edit" | "yolo";
  plan_enabled: boolean;
  planning_epoch: number | string;
  active_run_id: string | null;
  runtime_owner_id?: string | null;
  restore_operation_id?: string | null;
  execution_state: "ready" | "revoking" | "failed";
  run_state: "idle" | "running" | "stopping";
  next_input_seq: number | string;
};

export function designProjectFingerprint(row: DesignProjectRow): string {
  return parameterFingerprint({
    projectId: row.project_id,
    rootDirectory: row.canvas_root_directory ?? row.work_dir,
    additionalDirectories: row.additional_directories,
  });
}

export function designTaskPolicy(row: DesignTaskRow): DesignTaskPolicy {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    rootDirectory: row.root_directory,
    additionalDirectories: row.additional_directories,
    sandboxMode: row.sandbox_mode,
    scopeGeneration: Number(row.scope_generation),
    branchGeneration: Number(row.branch_generation),
    mode: row.permission_mode,
    planEnabled: row.plan_enabled,
    planningEpoch: Number(row.planning_epoch),
    activeRunId: row.active_run_id,
    executionState: row.execution_state,
  };
}

export async function loadDesignTask(
  sql: InstanceSqlClient,
  taskId: string,
  lock = false,
): Promise<DesignTaskRow | null> {
  return sql.queryOne<DesignTaskRow>(
    `select d.*, c.canvas_id from public.design_task_executions d
       join public.chat_sessions c on c.id=d.task_id and c.instance_id=d.instance_id
       join public.projects p on p.id=d.project_id and p.instance_id=d.instance_id
      where d.instance_id=:instance and d.task_id=$1 and c.project_id=p.id
        and c.mode='design' and p.kind='design' and p.archived_at is null
      ${lock ? "for update of d" : ""}`,
    [taskId],
  );
}

/** Called on the chat creation connection: session and execution identity commit together. */
export async function insertDesignTaskInTransaction(
  sql: InstanceSqlClient,
  taskId: string,
  prepared: DesignTaskPreparation,
): Promise<DesignTaskPolicy> {
  if (sql.instanceId !== prepared.instanceId)
    throw new DesignTaskError(
      "design_task_identity_mismatch",
      "实例归属不匹配",
    );
  const project = await sql.queryOne<DesignProjectRow>(
    `select p.id as project_id, v.id as canvas_id, p.kind, p.work_dir, p.additional_directories
       from public.projects p join public.canvases v on v.project_id=p.id
       join public.chat_sessions c on c.project_id=p.id and c.canvas_id=v.id
      where p.instance_id=:instance and c.instance_id=:instance and c.id=$1
        and p.id=$2 and v.id=$3 and c.mode='design' and p.kind='design'
        and p.archived_at is null and p.archive_state='open' for share of p, c`,
    [taskId, prepared.projectId, prepared.canvasId],
  );
  if (!project)
    throw new DesignTaskError("design_task_unavailable", "任务或项目不可用");
  project.canvas_root_directory = await claimCanvasRootInTransaction(
    sql,
    prepared.canvasId,
    async () => prepared.rootDirectory,
  );
  if (project.canvas_root_directory !== prepared.rootDirectory)
    throw new DesignTaskError(
      "design_project_scope_changed",
      "画布目录已变更，请重试",
    );
  const existing = await loadDesignTask(sql, taskId, true);
  if (existing) {
    await ensureDesignTaskOwner(sql, taskId, existing.project_id);
    return designTaskPolicy(existing);
  }
  if (designProjectFingerprint(project) !== prepared.projectFingerprint) {
    throw new DesignTaskError(
      "design_project_scope_changed",
      "项目目录已变更，请重试",
    );
  }
  await sql.execute(
    `insert into public.design_task_executions
       (task_id, instance_id, project_id, root_directory, additional_directories)
     values ($1,:instance,$2,$3,$4::jsonb) on conflict (task_id) do nothing`,
    [
      taskId,
      prepared.projectId,
      prepared.rootDirectory,
      JSON.stringify(prepared.additionalDirectories),
    ],
  );
  const created = await loadDesignTask(sql, taskId, true);
  if (!created)
    throw new DesignTaskError(
      "design_task_unavailable",
      "任务执行信息创建失败",
    );
  await ensureDesignTaskOwner(sql, taskId, created.project_id);
  return designTaskPolicy(created);
}

async function ensureDesignTaskOwner(
  sql: InstanceSqlClient,
  taskId: string,
  projectId: string,
): Promise<void> {
  const owner = await sql.queryOne(
    `insert into public.execution_task_owners(instance_id,task_id,project_id,task_kind,design_task_id)
      values (:instance,$1,$2,'design',$1)
      on conflict (instance_id,task_id) do update set task_id=excluded.task_id
      where execution_task_owners.project_id=excluded.project_id
        and execution_task_owners.task_kind='design'
        and execution_task_owners.design_task_id=excluded.design_task_id
      returning task_id`,
    [taskId, projectId],
  );
  if (!owner)
    throw new DesignTaskError("design_task_owner_conflict", "任务归属索引冲突");
}
