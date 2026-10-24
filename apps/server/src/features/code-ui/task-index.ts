import type { ZCodeTaskMeta } from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import type { CodeUiSessionRecord } from "./repository.js";

/** 仅适配原 Task 元信息；会话正文仍由原 V4 snapshots/rows 消费。 */
export function codeUiTaskMeta(
  record: CodeUiSessionRecord,
  workspacePath: string,
):
  | (ZCodeTaskMeta & {
      projectId: string;
      lastUnreadAt: number;
      pinRevision: number;
      pinned: boolean;
    })
  | null {
  const snapshot = record.state?.snapshots.find(
    (entry) => entry.sessionId === record.id,
  );
  if (
    record.deleted_at ||
    !snapshot ||
    !snapshot.rows.window.some((row) => row.kind === "userInput")
  )
    return null;
  const workModes = [
    ...new Set([
      ...(record.state?.runWorkContexts ?? []).map(
        ([, context]) => context.preset,
      ),
      ...(record.state?.inputs ?? []).flatMap((input) =>
        input.intent.workContext ? [input.intent.workContext.preset] : [],
      ),
      ...(record.state?.inheritedHistory ?? []).flatMap((turn) =>
        turn.canonical?.intent.workContext
          ? [turn.canonical.intent.workContext.preset]
          : [],
      ),
    ]),
  ];
  return {
    taskId: record.id,
    traceId: record.id,
    workspacePath,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(
      record.project_id,
      workspacePath,
    ),
    projectId: record.project_id,
    taskControl: {
      projectId: record.project_id,
      branchGeneration: Number(record.branch_generation),
    },
    conversationRevision: snapshot.revision,
    lastUnreadAt: Number(record.last_unread_at),
    pinRevision: Number(record.pin_revision),
    pinned: record.pinned,
    ...(record.unread_at !== null
      ? { unreadAt: Number(record.unread_at) }
      : {}),
    workModes: workModes.length ? workModes : ["code"],
    title: snapshot.meta.title,
    titleOverridden: snapshot.meta.titleSource === "custom",
    createdAt: Date.parse(record.created_at),
    updatedAt: Date.parse(record.updated_at),
    mode: snapshot.config.planEnabled
      ? "plan"
      : snapshot.config.mode === "yolo"
        ? "yolo"
        : "build",
    model: snapshot.config.model,
    ...(snapshot.config.thought
      ? { thoughtLevel: snapshot.config.thought }
      : {}),
    status:
      snapshot.control.phase === "error"
        ? "error"
        : snapshot.control.phase === "running"
          ? "running"
          : "completed",
  };
}
