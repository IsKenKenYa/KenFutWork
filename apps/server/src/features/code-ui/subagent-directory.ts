import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  type ZCodeSessionSubagentsParams,
  zcodeSessionSubagentsResultSchema,
} from "@zcode/shared";
import { z } from "zod";

const cursorSchema = z.object({
  childSessionId: z.string().min(1),
  endedAt: z.number().int().nonnegative(),
});

function cursor(value: string | undefined) {
  if (!value) return;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    return;
  }
}

/** 原目录只列直接且在当前分支可见的子会话，ended按原二元键分页。 */
export function listCodeSessionSubagents(
  snapshot: protocol.ConversationSnapshot,
  children: readonly protocol.ConversationSnapshot[],
  query: ZCodeSessionSubagentsParams,
) {
  const byId = new Map(children.map((child) => [child.sessionId, child]));
  const items = snapshot.rows.window.flatMap((row) => {
    if (
      row.kind !== "subagent" ||
      !row.childSessionId ||
      !byId.has(row.childSessionId)
    )
      return [];
    const child = byId.get(row.childSessionId);
    const status =
      row.status !== "running"
        ? row.status
        : child?.pendingInteractions.some(
              (interaction) => interaction.payload.kind === "permission",
            )
          ? "blocked"
          : child?.pendingInteractions.length
            ? "waiting"
            : "running";
    return [
      {
        childSessionId: row.childSessionId,
        subagentType: row.subagentType || "worker",
        title:
          child?.meta.title || row.summaryText || row.subagentType || "子任务",
        status,
        summary: row.summaryText,
        ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
        ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
        ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
      },
    ];
  });
  const running = items
    .filter((item) => ["running", "blocked", "waiting"].includes(item.status))
    .sort(
      (a, b) =>
        (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
        b.childSessionId.localeCompare(a.childSessionId),
    );
  const ended = items
    .filter((item) => !["running", "blocked", "waiting"].includes(item.status))
    .sort(
      (a, b) =>
        (b.endedAt ?? 0) - (a.endedAt ?? 0) ||
        b.childSessionId.localeCompare(a.childSessionId),
    );
  const after = cursor(query.endedCursor);
  const remaining = after
    ? ended.filter(
        (item) =>
          (item.endedAt ?? 0) < after.endedAt ||
          ((item.endedAt ?? 0) === after.endedAt &&
            item.childSessionId.localeCompare(after.childSessionId) < 0),
      )
    : ended;
  const page = remaining.slice(0, query.endedLimit);
  const last = page.at(-1);
  return zcodeSessionSubagentsResultSchema.parse({
    revision: snapshot.subagents?.revision ?? snapshot.revision,
    childSessionIds: items.map((item) => item.childSessionId),
    running,
    ended: {
      total: ended.length,
      items: page,
      ...(last && remaining.length > page.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                childSessionId: last.childSessionId,
                endedAt: last.endedAt ?? 0,
              }),
            ).toString("base64url"),
          }
        : {}),
    },
  });
}
