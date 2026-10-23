import type {
  CodeTaskGroupAdmission,
  CodeTaskGroupTaskRef,
} from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import {
  applyTaskGroupPlacement,
  prepareTaskGroupPlacement,
} from "./placement.js";

export interface TaskGroupAdmission {
  admit(
    actor: LocalActor,
    input: CodeTaskGroupAdmission,
    signal: AbortSignal,
  ): Promise<boolean>;
}

type TaskRow = SqlRow & {
  id: string;
  project_id: string;
  root_directory: string;
};

function taskReferences(tasks: CodeTaskGroupTaskRef[]) {
  const references = new Map<string, CodeTaskGroupTaskRef>();
  for (const task of tasks) {
    const id = task.taskId.toLowerCase();
    const previous = references.get(id);
    if (
      previous &&
      (previous.workspacePath !== task.workspacePath ||
        previous.workspaceIdentity !== task.workspaceIdentity)
    )
      throw new CodeUiHostRpcError(
        "invalid_code_ui_request",
        "任务目录信息不一致，请刷新任务列表。",
        400,
      );
    references.set(id, { ...task, taskId: id });
  }
  return references;
}

async function lockTasks(
  sql: InstanceSqlClient,
  references: Map<string, CodeTaskGroupTaskRef>,
  signal: AbortSignal,
) {
  const tasks = await sql.query<TaskRow>(
    `select s.id,s.project_id,s.root_directory
      from public.execution_task_owners o
      join public.code_ui_sessions s on s.instance_id=o.instance_id and s.id=o.code_task_id
      where o.instance_id=:instance and o.task_kind='code' and o.task_id=any($1::uuid[])
        and s.parent_session_id is null and s.deleted_at is null and s.root_directory is not null
      order by s.id for update of s`,
    [[...references.keys()]],
  );
  signal.throwIfAborted();
  return tasks;
}

function verifyTaskReferences(
  tasks: TaskRow[],
  references: ReadonlyMap<string, CodeTaskGroupTaskRef>,
) {
  for (const task of tasks) {
    const reference = references.get(task.id);
    if (
      !reference ||
      reference.workspacePath !== task.root_directory ||
      reference.workspaceIdentity !==
        canonicalLocalWorkspaceIdentity(task.project_id, task.root_directory)
    )
      throw new CodeUiHostRpcError(
        "task_group_revision_conflict",
        "任务目录已改变，请刷新任务列表。",
        409,
      );
  }
}

async function admitNewTasks(
  sql: InstanceSqlClient,
  tasks: TaskRow[],
  signal: AbortSignal,
) {
  const taskIds = tasks.map((task) => task.id);
  const members = await sql.query<SqlRow & { task_id: string }>(
    `select task_id from public.code_task_group_members
      where instance_id=:instance and task_kind='code' and task_id=any($1::uuid[])`,
    [taskIds],
  );
  signal.throwIfAborted();
  const registered = new Set(members.map((member) => member.task_id));
  const newIds = taskIds.filter((id) => !registered.has(id));
  if (!newIds.length) return false;
  const ordered = await sql.query<SqlRow & { id: string }>(
    `select id from public.code_ui_sessions
      where instance_id=:instance and id=any($1::uuid[]) order by created_at desc,id desc`,
    [newIds],
  );
  signal.throwIfAborted();
  await sql.execute(
    "update public.code_task_groups set sort_order=sort_order+$1 where instance_id=:instance",
    [ordered.length],
  );
  await sql.execute(
    `update public.code_task_group_members set sort_order=sort_order+$1
      where instance_id=:instance and group_id is null`,
    [ordered.length],
  );
  await sql.execute(
    `insert into public.code_task_group_members(instance_id,task_id,task_kind,group_id,sort_order)
      select :instance,p.task_id,'code',null,p.position
      from jsonb_to_recordset($1::jsonb) as p(task_id uuid,position integer)`,
    [
      JSON.stringify(
        ordered.map((task, position) => ({ task_id: task.id, position })),
      ),
    ],
  );
  return true;
}

export function createTaskGroupAdmission(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
}): TaskGroupAdmission {
  return {
    async admit(actor, input, signal) {
      signal.throwIfAborted();
      const owner = await deps.localInstance.resolve(actor);
      const references = taskReferences(input.tasks);
      signal.throwIfAborted();
      if (!references.size) return false;
      return deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(owner.instanceId);
        // Task 行按稳定身份取得锁；删除触发器沿同一 Task、state、members 次序执行。
        const tasks = await lockTasks(sql, references, signal);
        const state = await sql.queryOne(
          "select revision from public.code_task_group_state where instance_id=:instance for update",
        );
        signal.throwIfAborted();
        if (!state)
          throw new CodeUiHostRpcError(
            "task_groups_not_initialized",
            "分组数据尚未初始化，请重启应用。",
            503,
          );
        const placement = input.placement
          ? await prepareTaskGroupPlacement(
              sql,
              input.placement,
              references,
              tasks,
              signal,
            )
          : null;
        if (placement?.replayed) {
          signal.throwIfAborted();
          return false;
        }
        verifyTaskReferences(tasks, references);
        const admitted = await admitNewTasks(sql, tasks, signal);
        const placed = placement
          ? await applyTaskGroupPlacement(sql, placement.intent, signal)
          : false;
        const changed = admitted || placed;
        if (changed)
          await sql.execute(
            "update public.code_task_group_state set revision=revision+1 where instance_id=:instance",
          );
        signal.throwIfAborted();
        return changed;
      });
    },
  };
}
