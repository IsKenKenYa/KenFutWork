import type { CodeTaskGroupTaskRef } from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";

export type TaskGroupTaskRecord = SqlRow & {
  id: string;
  project_id: string;
  root_directory: string;
  archived: boolean;
};

export function taskGroupTaskReferences(tasks: CodeTaskGroupTaskRef[]) {
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

export async function lockTaskGroupTasks(
  sql: InstanceSqlClient,
  references: ReadonlyMap<string, CodeTaskGroupTaskRef>,
  signal: AbortSignal,
) {
  const tasks = await sql.query<TaskGroupTaskRecord>(
    `select s.id,s.project_id,s.root_directory,s.archived
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

export function verifyTaskGroupTaskReferences(
  tasks: readonly TaskGroupTaskRecord[],
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
