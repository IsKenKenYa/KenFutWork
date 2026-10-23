import {
  type CodeTaskGroupStructure,
  codeTaskGroupStructureSchema,
} from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import { projectTaskGroup, type TaskGroupRow } from "./group-record.js";

type MemberRow = SqlRow & {
  group_id: string | null;
  task_id: string;
  sort_order: number;
  project_id: string;
  root_directory: string;
};

export interface TaskGroupReader {
  read(actor: LocalActor, signal: AbortSignal): Promise<CodeTaskGroupStructure>;
}

function workspaceKey(task: MemberRow) {
  return canonicalLocalWorkspaceIdentity(task.project_id, task.root_directory);
}

function projectStructure(
  revision: string | number,
  groups: TaskGroupRow[],
  tasks: MemberRow[],
) {
  const order: CodeTaskGroupStructure["order"] = [
    ...groups.map((group) => ({
      type: "group" as const,
      key: group.id,
      sortOrder: group.sort_order,
    })),
    ...tasks
      .filter((task) => task.group_id === null)
      .map((task) => ({
        type: "task" as const,
        key: JSON.stringify([workspaceKey(task), task.task_id]),
        sortOrder: task.sort_order,
      })),
  ];
  order.sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.type.localeCompare(b.type) ||
      a.key.localeCompare(b.key),
  );
  return codeTaskGroupStructureSchema.parse({
    revision: Number(revision),
    groups: groups.map(projectTaskGroup),
    members: tasks.flatMap((task) =>
      task.group_id
        ? [
            {
              groupId: task.group_id,
              workspaceKey: workspaceKey(task),
              taskId: task.task_id,
              sortOrder: task.sort_order,
            },
          ]
        : [],
    ),
    order,
  });
}

export function createTaskGroupReader(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
}): TaskGroupReader {
  return {
    async read(actor, signal) {
      signal.throwIfAborted();
      const owner = await deps.localInstance.resolve(actor);
      return deps.persistence.transaction(async (tx) => {
        signal.throwIfAborted();
        await tx.execute(
          "set transaction isolation level repeatable read read only",
        );
        const sql = tx.forInstance(owner.instanceId);
        const state = await sql.queryOne<
          SqlRow & { revision: string | number }
        >(
          "select revision from public.code_task_group_state where instance_id=:instance",
        );
        if (!state)
          throw new CodeUiHostRpcError(
            "task_groups_not_initialized",
            "分组数据尚未初始化，请重启应用。",
            503,
          );
        signal.throwIfAborted();
        const groups = await sql.query<TaskGroupRow>(
          `select id,title,color,sort_order,created_at,updated_at
            from public.code_task_groups where instance_id=:instance order by created_at,id`,
        );
        signal.throwIfAborted();
        const tasks = await sql.query<MemberRow>(
          `select m.group_id,m.task_id,m.sort_order,s.project_id,s.root_directory
            from public.code_task_group_members m
            join public.execution_task_owners o on o.instance_id=m.instance_id
              and o.task_id=m.task_id and o.task_kind=m.task_kind
            join public.code_ui_sessions s on s.instance_id=o.instance_id and s.id=o.code_task_id
            where m.instance_id=:instance and s.parent_session_id is null
              and s.deleted_at is null and s.root_directory is not null
            order by m.sort_order,m.task_id`,
        );
        signal.throwIfAborted();
        return projectStructure(state.revision, groups, tasks);
      });
    },
  };
}
