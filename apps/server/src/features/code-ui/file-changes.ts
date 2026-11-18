import {
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { z } from "zod";
import { CodeUiRepositoryError } from "./repository.js";

const fullCommitSchema = z.object({
  filePath: z.string(),
  structuredPatch:
    protocol.fileDiffToolResultDisplaySchema.shape.structuredPatch,
});
const fullPatchSchema = z.object({ files: z.array(fullCommitSchema) });

/** 详情只消费已投影的真实文件提交；Read、shell与展示预览不计为写入。 */
export function collectTurnFileChanges(
  snapshot: protocol.ConversationSnapshot,
  turnId: string,
  events?: readonly Extract<StreamEvent, { type: "tool.completed" }>[],
): protocol.V4ConversationFileChangesResult {
  const files = new Map<
    string,
    protocol.V4ConversationFileChangesResult["items"][number]
  >();
  for (const row of snapshot.rows.window) {
    if (
      row.kind !== "toolCall" ||
      row.turnId !== turnId ||
      !["Write", "Edit", "ApplyPatch"].includes(row.toolName)
    )
      continue;
    const display = row.output?.display;
    const commits =
      display?.kind === "file_diff"
        ? [display]
        : display?.kind === "file_diffs"
          ? display.files
          : [];
    const full = events?.filter(
      (event) =>
        `${event.runId}/${event.toolCallId}` === row.toolCallId &&
        event.toolName === row.toolName,
    );
    const canonical =
      full && full.length === 1
        ? row.toolName === "ApplyPatch"
          ? fullPatchSchema.safeParse(full[0]!.output)
          : fullCommitSchema.safeParse(full[0]!.output)
        : undefined;
    const complete = canonical?.success
      ? "files" in canonical.data
        ? canonical.data.files
        : [canonical.data]
      : [];
    if (
      events &&
      commits.length &&
      (!canonical?.success || complete.length !== commits.length)
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "完整文件提交日志缺失，不能把截断预览当作完整详情。",
      );
    for (const commit of commits) {
      const file = files.get(commit.filePath) ?? {
        path: commit.filePath,
        additions: 0,
        deletions: 0,
        writeCount: 0,
        toolNames: [],
        patches: [],
      };
      file.additions += commit.additions;
      file.deletions += commit.deletions;
      file.writeCount += 1;
      if (!file.toolNames.includes(row.toolName))
        file.toolNames.push(row.toolName);
      const patch = events
        ? complete.find((entry) => entry.filePath === commit.filePath)
            ?.structuredPatch
        : commit.structuredPatch;
      if (!patch)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "文件提交日志与公开文件身份不匹配。",
        );
      file.patches.push(...structuredClone(patch));
      files.set(file.path, file);
    }
  }
  const items = [...files.values()];
  const header = snapshot.rows.window.find(
    (row) => row.kind === "turnHeader" && row.turnId === turnId,
  );
  return {
    files: items.length,
    additions: items.reduce((sum, file) => sum + file.additions, 0),
    deletions: items.reduce((sum, file) => sum + file.deletions, 0),
    state:
      header?.kind === "turnHeader" && header.fileChanges?.state === "reverted"
        ? "reverted"
        : "active",
    items,
  };
}

export function requireFileChangesTarget(
  snapshot: protocol.ConversationSnapshot,
  input: protocol.V4ConversationFileChangesParams,
): protocol.TurnHeaderRow {
  if (
    snapshot.revision !== input.baseRevision ||
    snapshot.logEpoch !== input.baseLogEpoch
  )
    throw new CodeUiRepositoryError(
      "revision_conflict",
      "会话已更新，请刷新文件变更详情。",
    );
  const row = snapshot.rows.window.find(
    (entry) =>
      entry.rowId === input.target.rowId &&
      entry.entityId === input.target.entityId,
  );
  if (row?.kind !== "turnHeader")
    throw new CodeUiRepositoryError(
      "not_found",
      "文件变更轮次不存在或身份不匹配。",
    );
  return row;
}

export function updateTurnFileSummary(
  snapshot: protocol.ConversationSnapshot,
  turnId: string,
) {
  const header = snapshot.rows.window.find(
    (row) => row.kind === "turnHeader" && row.turnId === turnId,
  );
  if (header?.kind !== "turnHeader") return;
  const { items: _items, ...summary } = collectTurnFileChanges(
    snapshot,
    turnId,
  );
  if (summary.files) header.fileChanges = summary;
}
