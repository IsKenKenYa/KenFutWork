import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import type { TaskGroupMoveIntent } from "./move-intent.js";

export async function replayTaskGroupMove(
  sql: InstanceSqlClient,
  intent: TaskGroupMoveIntent,
) {
  const receipt = await sql.queryOne<
    SqlRow & {
      parameter_fingerprint: string | null;
      deleted: boolean;
    }
  >(
    `select parameter_fingerprint,deleted from public.code_task_group_move_receipts
      where instance_id=:instance and node_type=$1 and node_id=$2 and expected_revision=$3`,
    [intent.node.type, intent.node.id, intent.expectedRevision],
  );
  if (!receipt) return false;
  if (receipt.deleted)
    throw new CodeUiHostRpcError(
      "code_ui_not_found",
      "移动目标已删除，请刷新分组列表。",
      404,
    );
  if (receipt.parameter_fingerprint !== intent.fingerprint)
    throw new CodeUiHostRpcError(
      "task_group_revision_conflict",
      "同一次移动的内容已改变，请重新操作。",
      409,
    );
  return true;
}

export function writeTaskGroupMoveReceipt(
  sql: InstanceSqlClient,
  intent: TaskGroupMoveIntent,
) {
  return sql.execute(
    `insert into public.code_task_group_move_receipts
      (instance_id,node_type,node_id,expected_revision,parameter_fingerprint,
        source_group_id,target_group_id,anchor_type,anchor_id)
      values (:instance,$1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      intent.node.type,
      intent.node.id,
      intent.expectedRevision,
      intent.fingerprint,
      intent.sourceGroupId,
      intent.groupId,
      intent.anchor?.node.type ?? null,
      intent.anchor?.node.id ?? null,
    ],
  );
}
