import type { CodeTaskGroupAdmission } from "@kenfutwork/shared";
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
import {
  lockTaskGroupTasks,
  type TaskGroupTaskRecord,
  taskGroupTaskReferences,
  verifyTaskGroupTaskReferences,
} from "./references.js";

export interface TaskGroupAdmission {
  admit(
    actor: LocalActor,
    input: CodeTaskGroupAdmission,
    signal: AbortSignal,
  ): Promise<boolean>;
}

async function admitNewTasks(
  sql: InstanceSqlClient,
  tasks: TaskGroupTaskRecord[],
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
      const references = taskGroupTaskReferences(input.tasks);
      signal.throwIfAborted();
      if (!references.size) return false;
      return deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(owner.instanceId);
        // Task 行按稳定身份取得锁；删除触发器沿同一 Task、state、members 次序执行。
        const tasks = await lockTaskGroupTasks(sql, references, signal);
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
        verifyTaskGroupTaskReferences(tasks, references);
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
