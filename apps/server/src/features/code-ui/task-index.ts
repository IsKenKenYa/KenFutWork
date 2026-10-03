import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CodeUiSessionRecord } from "./repository.js";

/** 仅适配原 Task 元信息；会话正文仍由原 V4 snapshots/rows 消费。 */
export function codeUiTaskMeta(
  record: CodeUiSessionRecord,
  workspacePath: string,
): ZCodeTaskMeta | null {
  const snapshot = record.state?.snapshots.find(
    (entry) => entry.sessionId === record.id,
  );
  if (
    record.deleted_at ||
    !snapshot ||
    !snapshot.rows.window.some((row) => row.kind === "userInput")
  )
    return null;
  return {
    taskId: record.id,
    traceId: record.id,
    workspacePath,
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
