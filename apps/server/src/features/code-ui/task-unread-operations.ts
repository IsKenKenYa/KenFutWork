import { createHash } from "node:crypto";
import type { CodeTaskUnreadInput } from "@kenfutwork/shared";
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

function conflict(message = "任务已改变，请刷新后重试。") {
  return taskOrganizationConflict("task_unread_conflict", message);
}

function operationFor(
  instanceId: string,
  input: CodeTaskUnreadInput,
): TaskOrganizationOperation {
  const control = input.taskControl;
  return {
    owner: "code-ui:task-unread",
    conflictCode: "task_unread_conflict",
    key: JSON.stringify([
      instanceId,
      input.taskId,
      control.projectId,
      control.branchGeneration,
      input.observedLastUnreadAt,
      input.unread,
    ]),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          input.taskId,
          input.workspacePath,
          input.workspaceIdentity,
          control.projectId,
          control.branchGeneration,
          input.observedLastUnreadAt,
          input.unread,
          input.expectedUnreadAt ?? null,
        ]),
      )
      .digest("hex"),
  };
}

async function applyUnread(
  sql: InstanceSqlClient,
  root: CodeUiSessionRecord,
  input: CodeTaskUnreadInput,
) {
  const unreadAt = root.unread_at === null ? null : Number(root.unread_at);
  const lastUnreadAt = Number(root.last_unread_at);
  if (
    !input.unread &&
    input.expectedUnreadAt !== undefined &&
    unreadAt !== input.expectedUnreadAt
  )
    return taskOrganizationMeta(root);
  if (lastUnreadAt !== input.observedLastUnreadAt) throw conflict();
  if (!input.unread && unreadAt === null) return taskOrganizationMeta(root);
  const marker = input.unread ? Math.max(Date.now(), lastUnreadAt + 1) : null;
  if (marker !== null && !Number.isSafeInteger(marker))
    throw conflict("未读标记无效，请重新加载任务。");
  const updated = await sql.queryOne<CodeUiSessionRecord>(
    `update public.code_ui_sessions set unread_at=$2,
      last_unread_at=case when $2::bigint is null then last_unread_at else $2::bigint end
      where instance_id=:instance and id=$1 returning *`,
    [root.id, marker],
  );
  if (!updated) throw taskOrganizationNotFound();
  return taskOrganizationMeta(updated);
}

/** 未读标记与回执共用根 Task 行锁；清除后保留水位，旧 marker 不会再次分配。 */
export function createTaskUnreadOperations(persistence: PersistenceService) {
  return {
    change(
      instanceId: string,
      input: CodeTaskUnreadInput,
      signal: AbortSignal,
    ) {
      const operation = operationFor(instanceId, input);
      return changeTaskOrganization(
        persistence,
        instanceId,
        input,
        operation,
        signal,
        (sql, root) => applyUnread(sql, root, input),
      );
    },
  };
}
