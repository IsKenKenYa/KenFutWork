import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AgentContextResourceBinding } from "../../agent/context-history.js";
import { createContextResourceRebinder } from "../../agent/context-resource-bindings.js";
import type { LocalActor } from "../local-instance/types.js";
import { collectTurnFileChanges } from "./file-changes.js";
import { requireStoredFileChanges } from "./owned-history.js";
import type { CodeUiInheritedSession } from "./owned-history-types.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { CodeUiRepositoryError } from "./repository.js";
import type { CodeUiServiceDeps } from "./service.js";

type Snapshot = protocol.ConversationSnapshot;
type Row = protocol.ConversationRow;

/** 只选父转录实际引用的完整后代图，完成事实不借后续流的可变快照。 */
export function freezeChildSnapshots(
  root: Snapshot,
  snapshots: ReadonlyMap<string, Snapshot>,
) {
  const result: Snapshot[] = [];
  const seen = new Set([root.sessionId]);
  const pending = [root];
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index];
    if (!parent) throw new Error("子历史图游标缺失");
    for (const row of parent.rows.window) {
      if (row.kind !== "subagent" || !row.childSessionId) continue;
      if (seen.has(row.childSessionId))
        throw new CodeUiRepositoryError(
          "command_conflict",
          "子历史图存在循环或多父关联。",
        );
      const child = snapshots.get(row.childSessionId);
      if (!child)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "可见子历史缺少独立转录。",
        );
      seen.add(child.sessionId);
      pending.push(child);
      result.push(structuredClone(child));
    }
  }
  return result;
}

export interface HistoryIdentityMap {
  rootId: string;
  sessions: ReadonlyMap<string, string>;
  turns: ReadonlyMap<string, string>;
  resourceBindings?: readonly AgentContextResourceBinding[];
  attachments(
    refs: readonly protocol.AttachmentRef[],
    sourceSessionId: string,
  ): protocol.AttachmentRef[];
}

export function remapHistoryRows(
  rows: readonly Row[],
  sessionId: string,
  sourceSessionId: string,
  identity: HistoryIdentityMap,
): Row[] {
  const resources = identity.resourceBindings?.length ? createContextResourceRebinder(identity.resourceBindings) : null;
  const entities = new Map(
    rows.flatMap((row, index) =>
      row.entityId
        ? [[row.entityId, `${sessionId}:history-row:${index + 1}`] as const]
        : [],
    ),
  );
  return structuredClone(rows).map((row, index) => {
    delete row.actions;
    if ("workId" in row) delete row.workId;
    row.turnId = identity.turns.get(row.turnId) ?? row.turnId;
    row.productTurnId = row.turnId;
    row.rowId = index + 1;
    row.createdAtSeq = index + 1;
    row.entityId = `${sessionId}:history-row:${index + 1}`;
    if (row.kind === "userInput" && row.attachments)
      row.attachments = identity.attachments(row.attachments, sourceSessionId);
    if (row.kind === "turnHeader" && row.workSegments)
      for (const [i, segment] of row.workSegments.entries()) {
        segment.segmentId = `${row.turnId}:history-segment:${i + 1}`;
        if (segment.triggerEntityId)
          segment.triggerEntityId = entities.get(segment.triggerEntityId);
      }
    if ("assistantResponseId" in row && row.assistantResponseId)
      row.assistantResponseId = `${identity.rootId}:history-response:${row.assistantResponseId}`;
    if (row.kind === "toolCall") {
      row.toolCallId = `${identity.rootId}:history-tool:${row.toolCallId}`;
      remapToolResources(row, resources);
    }
    if (row.kind === "subagent") {
      if (row.parentToolCallId)
        row.parentToolCallId = `${identity.rootId}:history-tool:${row.parentToolCallId}`;
      if (row.childSessionId) {
        const child = identity.sessions.get(row.childSessionId);
        if (!child)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "子历史身份映射不完整。",
          );
        row.childSessionId = child;
      }
    }
    if (row.kind === "hookInvocation") {
      row.hookInvocationId = `${identity.rootId}:history-hook:${row.hookInvocationId}`;
      if (row.anchorToolCallId)
        row.anchorToolCallId = `${identity.rootId}:history-tool:${row.anchorToolCallId}`;
    }
    return row;
  });
}

function remapToolResources(
  row: Extract<Row, { kind: "toolCall" }>,
  resources: ReturnType<typeof createContextResourceRebinder> | null,
) {
  if (!resources) return;
  if (row.output?.display) {
    const mapped = resources.payload(row.toolName, { display: row.output.display });
    if (mapped && typeof mapped === "object" && "display" in mapped)
      row.output = protocol.toolOutputSchema.parse({ ...row.output, display: mapped.display });
  }
  if (row.input && row.toolName === "TaskOutput") {
    const mapped = resources.args(row.toolName, row.input);
    if (mapped && typeof mapped === "object" && !Array.isArray(mapped)) {
      row.input = { ...mapped };
      row.inputText = JSON.stringify(row.input);
    }
  }
  if (!row.output?.text || !["Task", "TaskOutput", "Bash"].includes(row.toolName)) return;
  let payload: unknown;
  try { payload = JSON.parse(row.output.text); } catch { return; } // 普通工具错误正文不包含结构化资源。
  row.output.text = JSON.stringify(resources.payload(row.toolName, payload));
}

export function closeInheritedSnapshot(snapshot: Snapshot) {
  const clipped =
    snapshot.control.phase === "running" ||
    snapshot.control.phase === "prewarming";
  if (clipped) {
    snapshot.control.phase = "completedInterrupted";
    snapshot.meta.title = `${snapshot.meta.title}（分叉截点历史，未继承执行）`;
    snapshot.control.lastError = {
      code: "guard.historyCutoff",
      message:
        "仅显示分叉截点的只读历史，副本停止同步；源子代理仍在原Task运行。",
      recoverable: false,
      source: "runtime",
      at: Date.now(),
    };
    for (const row of snapshot.rows.window) {
      if (row.kind === "turnHeader" && row.state === "running")
        row.state = "completedInterrupted";
      if (row.kind === "assistantText" && row.state === "streaming")
        row.state = "interrupted";
      if (
        row.kind === "toolCall" &&
        (row.status === "running" || row.status === "pendingApproval")
      )
        row.status = "cancelled";
    }
  }
  snapshot.control.canStop = false;
  snapshot.control.activeWorks = [];
  snapshot.control.stopState = "idle";
  snapshot.control.sessionEnded = true;
  snapshot.inputRouting = {
    mode: "reject",
    reasonCode: "guard.historicalSessionReadOnly",
  };
  snapshot.pendingInteractions = [];
  snapshot.pendingCommands = [];
  snapshot.backgroundWorks = [];
  snapshot.queue.items = [];
  snapshot.queue.autoDrain = false;
  delete snapshot.config.permissionGrant;
  delete snapshot.config.planTransition;
  for (const action of Object.keys(snapshot.availability) as Array<
    keyof Snapshot["availability"]
  >)
    snapshot.availability[action] = {
      allowed: false,
      reasonCode: "guard.historicalSessionReadOnly",
    };
  if (snapshot.subagents) {
    snapshot.subagents.running = [];
    snapshot.subagents.endedTotal = snapshot.subagents.childSessionIds.length;
  }
  return clipped;
}

export function remapChildSnapshot(
  original: Snapshot,
  identity: HistoryIdentityMap,
) {
  const copied = structuredClone(original);
  const sessionId = identity.sessions.get(original.sessionId);
  if (!sessionId)
    throw new CodeUiRepositoryError("command_conflict", "子历史映射缺失。");
  copied.sessionId = sessionId;
  copied.logEpoch = randomUUID();
  copied.rows.window = remapHistoryRows(
    original.rows.window,
    sessionId,
    original.sessionId,
    identity,
  );
  copied.rows.totalCount = copied.rows.window.length;
  copied.rows.firstRowId = copied.rows.window[0]?.rowId ?? null;
  copied.seq = copied.rows.window.length;
  if (copied.subagents)
    copied.subagents.childSessionIds = copied.subagents.childSessionIds.map(
      (id) => identity.sessions.get(id) ?? id,
    );
  closeInheritedSnapshot(copied);
  return copied;
}

export function childIdentityMap(
  rootId: string,
  snapshots: readonly Snapshot[],
  turns: Map<string, string>,
) {
  const sessions = new Map<string, string>();
  for (const snapshot of snapshots) {
    sessions.set(snapshot.sessionId, randomUUID());
    for (const row of snapshot.rows.window)
      if (!turns.has(row.turnId)) turns.set(row.turnId, randomUUID());
  }
  return { rootId, sessions, turns };
}

export async function childFileChanges(
  deps: Pick<CodeUiServiceDeps, "repository" | "settings">,
  actor: LocalActor,
  root: CodeUiSessionRecord,
  snapshot: Snapshot,
): Promise<CodeUiInheritedSession["fileChanges"]> {
  const changed = new Set(
    snapshot.rows.window.flatMap((row) =>
      row.kind === "toolCall" &&
      ["Write", "Edit", "ApplyPatch"].includes(row.toolName) &&
      ["file_diff", "file_diffs"].includes(row.output?.display?.kind ?? "")
        ? [row.turnId]
        : [],
    ),
  );
  if (!changed.size) return [];
  const settings = await deps.settings.getInstanceSettings(
    actor,
    root.instance_id,
  );
  const limits = {
    maxEvents: settings.codeSearchMaxResults,
    maxBytes: settings.codePatchMaxBytes,
  };
  const inherited = root.state?.inheritedSessions?.find(
    (session) => session.owner.sessionId === snapshot.sessionId,
  );
  if (
    inherited &&
    (inherited.owner.instanceId !== actor.instanceId ||
      inherited.owner.taskId !== root.id ||
      inherited.owner.projectId !== root.project_id)
  )
    throw new CodeUiRepositoryError(
      "command_conflict",
      "子历史文件详情不属于当前Task。",
    );
  const result: CodeUiInheritedSession["fileChanges"] = [];
  for (const turnId of changed) {
    const stored = inherited?.fileChanges.find(
      (item) => item.turnId === turnId,
    )?.details;
    if (stored) {
      requireStoredFileChanges(stored, limits);
      result.push({ turnId, details: structuredClone(stored) });
      continue;
    }
    const events = await deps.repository.readToolCompletions(
      root.instance_id,
      root.id,
      turnId,
      limits,
    );
    result.push({
      turnId,
      details: {
        result: collectTurnFileChanges(snapshot, turnId, events),
        eventCount: events.length,
        bytes: Buffer.byteLength(JSON.stringify(events)),
      },
    });
  }
  return result;
}
