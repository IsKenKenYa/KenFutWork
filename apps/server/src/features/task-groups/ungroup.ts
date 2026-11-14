import type { CodeTaskGroupUngroup } from "@kenfutwork/shared";
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
  readTaskGroupMemberOrder,
  readTaskGroupRootOrder,
  writeTaskGroupRootOrder,
} from "./order.js";

export interface TaskGroupUngrouper {
  ungroup(
    actor: LocalActor,
    input: CodeTaskGroupUngroup,
    signal: AbortSignal,
  ): Promise<void>;
}

async function releaseMembers(sql: InstanceSqlClient, groupId: string) {
  const root = await readTaskGroupRootOrder(sql);
  const members = await readTaskGroupMemberOrder(sql, groupId);
  const order = root.flatMap((node) =>
    node.type === "group" && node.id === groupId ? members : [node],
  );
  await sql.execute(
    `update public.code_task_group_members set group_id=null,user_organized=true,
      updated_at=clock_timestamp() where instance_id=:instance and group_id=$1`,
    [groupId],
  );
  await sql.execute(
    "delete from public.code_task_groups where instance_id=:instance and id=$1",
    [groupId],
  );
  await writeTaskGroupRootOrder(sql, order);
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
