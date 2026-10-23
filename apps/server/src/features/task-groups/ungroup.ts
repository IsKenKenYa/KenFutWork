import type { CodeTaskGroupUngroup } from "@kenfutwork/shared";
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
import { compareTaskGroupRootNodes } from "./group-record.js";

export interface TaskGroupUngrouper {
  ungroup(
    actor: LocalActor,
    input: CodeTaskGroupUngroup,
    signal: AbortSignal,
  ): Promise<void>;
}

type OrderNode = SqlRow & {
  type: "group" | "task";
  id: string;
  sort_order: number;
};

async function releaseMembers(sql: InstanceSqlClient, groupId: string) {
  const root = await sql.query<
    OrderNode & { project_id: string; root_directory: string }
  >(
    `select 'group' as type,id,sort_order,null::uuid as project_id,null::text as root_directory from public.code_task_groups
      where instance_id=:instance
      union all select 'task',m.task_id,m.sort_order,s.project_id,s.root_directory
      from public.code_task_group_members m
      join public.execution_task_owners o on o.instance_id=m.instance_id
        and o.task_id=m.task_id and o.task_kind=m.task_kind
      join public.code_ui_sessions s on s.instance_id=o.instance_id and s.id=o.code_task_id
      where m.instance_id=:instance and m.group_id is null and s.parent_session_id is null
        and s.deleted_at is null and s.root_directory is not null`,
  );
  const members = await sql.query<OrderNode>(
    `select 'task' as type,task_id as id,sort_order from public.code_task_group_members
      where instance_id=:instance and group_id=$1 order by sort_order,task_id`,
    [groupId],
  );
  const order = root
    .map((node) => ({
      ...node,
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
    .sort(compareTaskGroupRootNodes)
    .flatMap((node) =>
      node.type === "group" && node.id === groupId ? members : [node],
    )
    .map((node, position) => ({ type: node.type, id: node.id, position }));
  await sql.execute(
    `update public.code_task_group_members set group_id=null,user_organized=true,
      updated_at=clock_timestamp() where instance_id=:instance and group_id=$1`,
    [groupId],
  );
  await sql.execute(
    "delete from public.code_task_groups where instance_id=:instance and id=$1",
    [groupId],
  );
  const positions = JSON.stringify(order);
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

export function createTaskGroupUngrouper(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
}): TaskGroupUngrouper {
  return {
    async ungroup(actor, input, signal) {
      signal.throwIfAborted();
      const owner = await deps.localInstance.resolve(actor);
      const id = input.id.toLowerCase();
      // 严格输入只有业务身份与观察修订；规范化意图与业务键相同。
      const key = JSON.stringify(["ungroup", id, input.expectedRevision]);
      await deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(owner.instanceId);
        const state = await sql.queryOne<
          SqlRow & { revision: string | number }
        >(
          "select revision from public.code_task_group_state where instance_id=:instance for update",
        );
        signal.throwIfAborted();
        if (!state)
          throw new CodeUiHostRpcError(
            "task_groups_not_initialized",
            "分组数据尚未初始化，请重启应用。",
            503,
          );
        const replay = await sql.queryOne(
          `select group_id from public.code_task_group_save_receipts
            where instance_id=:instance and operation_key=$1 and group_id=$2 and deleted`,
          [key, id],
        );
        if (replay) return;
        const group = await sql.queryOne(
          "select id from public.code_task_groups where instance_id=:instance and id=$1",
          [id],
        );
        if (!group)
          throw new CodeUiHostRpcError(
            "task_group_not_found",
            "分组已删除，请刷新列表。",
            404,
          );
        if (Number(state.revision) !== input.expectedRevision)
          throw new CodeUiHostRpcError(
            "task_group_revision_conflict",
            "分组已改变，请刷新后重新操作。",
            409,
          );
        await releaseMembers(sql, id);
        await sql.execute(
          "update public.code_task_group_state set revision=revision+1 where instance_id=:instance",
        );
        // 共用原分组事务回执，取消后只保留不透明身份，不保存名称或参数指纹。
        await sql.execute(
          `insert into public.code_task_group_save_receipts
            (instance_id,operation_key,group_id,deleted) values (:instance,$1,$2,true)`,
          [key, id],
        );
        signal.throwIfAborted();
      });
    },
  };
}
