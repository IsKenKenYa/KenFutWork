import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import { compareTaskGroupRootNodes } from "./group-record.js";

export type TaskGroupOrderNode = {
  type: "group" | "task";
  id: string;
  sortOrder: number;
};
type RootRow = SqlRow & { id: string; sort_order: number } & (
    | { type: "group"; project_id: null; root_directory: null }
    | { type: "task"; project_id: string; root_directory: string }
  );

export async function readTaskGroupRootOrder(
  sql: InstanceSqlClient,
): Promise<TaskGroupOrderNode[]> {
  const rows = await sql.query<RootRow>(
    `select 'group' as type,id,sort_order,null::uuid as project_id,null::text as root_directory
      from public.code_task_groups where instance_id=:instance
      union all select 'task',m.task_id,m.sort_order,s.project_id,s.root_directory
      from public.code_task_group_members m
      join public.execution_task_owners o on o.instance_id=m.instance_id
        and o.task_id=m.task_id and o.task_kind=m.task_kind
      join public.code_ui_sessions s on s.instance_id=o.instance_id and s.id=o.code_task_id
      where m.instance_id=:instance and m.group_id is null and s.parent_session_id is null
        and s.deleted_at is null and s.root_directory is not null`,
  );
  return rows
    .map((node) => ({
      type: node.type,
      id: node.id,
      sortOrder: node.sort_order,
      key:
        node.type === "group"
          ? node.id
          : JSON.stringify([
              canonicalLocalWorkspaceIdentity(
                node.project_id,
                node.root_directory,
              ),
              node.id,
            ]),
    }))
    .sort(compareTaskGroupRootNodes);
}

export async function readTaskGroupMemberOrder(
  sql: InstanceSqlClient,
  groupId: string,
): Promise<TaskGroupOrderNode[]> {
  const rows = await sql.query<SqlRow & { id: string; sort_order: number }>(
    `select task_id as id,sort_order from public.code_task_group_members
      where instance_id=:instance and group_id=$1 order by sort_order,task_id`,
    [groupId],
  );
  return rows.map((row) => ({
    type: "task",
    id: row.id,
    sortOrder: row.sort_order,
  }));
}

export function taskGroupOrderChanged(
  previous: readonly TaskGroupOrderNode[],
  next: readonly Pick<TaskGroupOrderNode, "type" | "id">[],
) {
  return (
    previous.length !== next.length ||
    previous.some(
      (node, position) =>
        node.type !== next[position]?.type ||
        node.id !== next[position]?.id ||
        node.sortOrder !== position,
    )
  );
}

export async function writeTaskGroupRootOrder(
  sql: InstanceSqlClient,
  nodes: readonly Pick<TaskGroupOrderNode, "type" | "id">[],
) {
  const positions = JSON.stringify(
    nodes.map((node, position) => ({ type: node.type, id: node.id, position })),
  );
  await sql.execute(
    `update public.code_task_groups g set sort_order=p.position
      from jsonb_to_recordset($1::jsonb) as p(type text,id uuid,position integer)
      where g.instance_id=:instance and p.type='group' and g.id=p.id`,
    [positions],
  );
  await sql.execute(
    `update public.code_task_group_members m set sort_order=p.position
      from jsonb_to_recordset($1::jsonb) as p(type text,id uuid,position integer)
      where m.instance_id=:instance and m.group_id is null
        and p.type='task' and m.task_id=p.id`,
    [positions],
  );
}

export async function writeTaskGroupMemberOrder(
  sql: InstanceSqlClient,
  groupId: string,
  nodes: readonly Pick<TaskGroupOrderNode, "type" | "id">[],
) {
  await sql.execute(
    `update public.code_task_group_members m set sort_order=p.position
      from jsonb_to_recordset($1::jsonb) as p(id uuid,position integer)
      where m.instance_id=:instance and m.group_id=$2 and m.task_id=p.id`,
    [
      JSON.stringify(
        nodes.map((node, position) => ({ id: node.id, position })),
      ),
      groupId,
    ],
  );
}
