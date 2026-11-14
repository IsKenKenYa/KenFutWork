import { createHash, randomUUID } from "node:crypto";
import {
  type CodeTaskGroup,
  type CodeTaskGroupSave,
  codeTaskGroupSchema,
} from "@kenfutwork/shared";
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
import { projectTaskGroup, type TaskGroupRow } from "./group-record.js";

export interface TaskGroupWriter {
  save(
    actor: LocalActor,
    input: CodeTaskGroupSave,
    signal: AbortSignal,
  ): Promise<CodeTaskGroup>;
}

function conflict(message = "分组已改变，请刷新后重新编辑。") {
  return new CodeUiHostRpcError("task_group_revision_conflict", message, 409);
}

function operation(input: CodeTaskGroupSave) {
  const edit = "id" in input;
  const key = JSON.stringify(
    edit
      ? ["edit", input.id.toLowerCase(), input.expectedRevision]
      : ["create", input.creationId.toLowerCase()],
  );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        input.expectedRevision,
        input.title ?? (edit ? null : "New group"),
        input.color ?? (edit ? null : "gray"),
      ]),
    )
    .digest("hex");
  return { key, fingerprint };
}

async function readReceipt(
  sql: InstanceSqlClient,
  intent: ReturnType<typeof operation>,
) {
  const receipt = await sql.queryOne<
    SqlRow & {
      parameter_fingerprint: string | null;
      result: unknown;
      deleted: boolean;
    }
  >(
    `select parameter_fingerprint,result,deleted from public.code_task_group_save_receipts
      where instance_id=:instance and operation_key=$1`,
    [intent.key],
  );
  if (!receipt) return null;
  if (receipt.deleted)
    throw new CodeUiHostRpcError(
      "task_group_not_found",
      "分组已删除，请刷新列表。",
      404,
    );
  if (receipt.parameter_fingerprint !== intent.fingerprint)
    throw conflict("同一次分组操作的内容已改变，请重新编辑。");
  return codeTaskGroupSchema.parse(receipt.result);
}

async function saveGroup(sql: InstanceSqlClient, input: CodeTaskGroupSave) {
  if ("id" in input) {
    const previous = await sql.queryOne<TaskGroupRow>(
      "select * from public.code_task_groups where instance_id=:instance and id=$1 for update",
      [input.id],
    );
    if (!previous)
      throw new CodeUiHostRpcError(
        "task_group_not_found",
        "分组已删除，请刷新列表。",
        404,
      );
    const title = input.title ?? previous.title;
    const color = input.color ?? previous.color;
    if (title === previous.title && color === previous.color)
      return { group: projectTaskGroup(previous), changed: false };
    const updated = await sql.queryOne<TaskGroupRow>(
      `update public.code_task_groups set title=$2,color=$3,updated_at=clock_timestamp()
        where instance_id=:instance and id=$1 returning *`,
      [input.id, title, color],
    );
    if (!updated) throw new Error("分组编辑没有返回保存结果。");
    return { group: projectTaskGroup(updated), changed: true };
  }
  await sql.execute(
    "update public.code_task_groups set sort_order=sort_order+1 where instance_id=:instance",
  );
  await sql.execute(`update public.code_task_group_members set sort_order=sort_order+1
    where instance_id=:instance and group_id is null`);
  const created = await sql.queryOne<TaskGroupRow>(
    `insert into public.code_task_groups(instance_id,id,title,color,sort_order)
      values (:instance,$1,$2,$3,0) returning *`,
    [randomUUID(), input.title ?? "New group", input.color ?? "gray"],
  );
  if (!created) throw new Error("分组创建没有返回保存结果。");
  return { group: projectTaskGroup(created), changed: true };
}

export function createTaskGroupWriter(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
}): TaskGroupWriter {
  return {
    async save(actor, input, signal) {
      signal.throwIfAborted();
      const owner = await deps.localInstance.resolve(actor);
      const intent = operation(input);
      return deps.persistence.transaction(async (tx) => {
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
        const replay = await readReceipt(sql, intent);
        if (replay) return replay;
        if (Number(state.revision) !== input.expectedRevision) throw conflict();
        const result = await saveGroup(sql, input);
        signal.throwIfAborted();
        if (!result.changed) return result.group;
        await sql.execute(
          "update public.code_task_group_state set revision=revision+1 where instance_id=:instance",
        );
        await sql.execute(
          `insert into public.code_task_group_save_receipts
          (instance_id,operation_key,group_id,parameter_fingerprint,result)
          values (:instance,$1,$2,$3,$4::jsonb)`,
          [
            intent.key,
            result.group.id,
            intent.fingerprint,
            JSON.stringify(result.group),
          ],
        );
        signal.throwIfAborted();
        return result.group;
      });
    },
  };
}
