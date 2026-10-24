import { createHash } from "node:crypto";
import type { CodeTaskPinInput } from "@kenfutwork/shared";
import type {
  InstanceSqlClient,
  PersistenceService,
} from "../persistence/types.js";
import type { CodeUiSessionRecord } from "./repository.js";
import {
  changeTaskOrganization,
  type TaskOrganizationOperation,
  taskOrganizationConflict,
  taskOrganizationMeta,
  taskOrganizationNotFound,
} from "./task-organization-operation.js";

function operationFor(
  instanceId: string,
  input: CodeTaskPinInput,
): TaskOrganizationOperation {
  const control = input.taskControl;
  return {
    owner: "code-ui:task-pin",
    conflictCode: "task_pin_conflict",
    key: JSON.stringify([
      instanceId,
      input.taskId,
      control.projectId,
      control.branchGeneration,
      input.observedPinRevision,
      input.pinned,
    ]),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          input.taskId,
          input.workspacePath,
          input.workspaceIdentity,
          control.projectId,
          control.branchGeneration,
          input.observedPinRevision,
          input.pinned,
        ]),
      )
      .digest("hex"),
  };
}

async function applyPin(
  sql: InstanceSqlClient,
  root: CodeUiSessionRecord,
  input: CodeTaskPinInput,
) {
  const revision = Number(root.pin_revision);
  if (revision !== input.observedPinRevision)
    throw taskOrganizationConflict("task_pin_conflict");
  if (root.pinned === input.pinned) return taskOrganizationMeta(root);
  if (!Number.isSafeInteger(revision + 1))
    throw taskOrganizationConflict(
      "task_pin_conflict",
      "置顶修订无效，请重新加载任务。",
    );
  const updated = await sql.queryOne<CodeUiSessionRecord>(
    `update public.code_ui_sessions set pinned=$2,pin_revision=pin_revision+1
      where instance_id=:instance and id=$1 returning *`,
    [root.id, input.pinned],
  );
  if (!updated) throw taskOrganizationNotFound();
  return taskOrganizationMeta(updated);
}

/** 置顶使用独立修订，与正文、活动时间、未读水位及执行权限分别持有。 */
export function createTaskPinOperations(persistence: PersistenceService) {
  return {
    change(instanceId: string, input: CodeTaskPinInput, signal: AbortSignal) {
      return changeTaskOrganization(
        persistence,
        instanceId,
        input,
        operationFor(instanceId, input),
        signal,
        (sql, root) => applyPin(sql, root, input),
      );
    },
  };
}
