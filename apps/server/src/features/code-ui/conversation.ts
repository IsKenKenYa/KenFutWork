import { randomUUID } from "node:crypto";
import { sep } from "node:path";
import {
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import type { z } from "zod";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import { deriveSessionTitle } from "../chat/session-title.js";

type Snapshot = protocol.ConversationSnapshot;
type Row = protocol.ConversationRow;
type Config = protocol.SessionConfigState;

function fileToolInput(
  workspacePath: string,
  event: Extract<StreamEvent, { type: "tool.started" }>,
) {
  if (
    !["read_file", "write_file", "edit_file"].includes(event.toolName) ||
    !event.input
  )
    return event.input;
  const input = { ...event.input };
  const path = input.file_path;
  if (
    typeof path !== "string" ||
    path === workspacePath ||
    path.startsWith(workspacePath + sep)
  )
    return input;
  // DeepAgents 的绝对路径属于沙箱虚拟根；原 viewer 的 path 属于宿主文件系统。
  input.file_path = resolveInsideRoot(workspacePath, path.replace(/^\/+/, ""));
  return input;
}

export interface CodeUiConversationState {
  version: 1;
  runId: string;
  snapshots: Snapshot[];
  dispatches: Array<[string, string]>;
  closedRuns: string[];
}

function cancelSnapshot(snapshot: Snapshot, at: number) {
  snapshot.control = {
    ...snapshot.control,
    phase: "completedInterrupted",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    activeWorks: [],
  };
  snapshot.inputRouting = { mode: "startNow" };
  for (const row of snapshot.rows.window) {
    if (
      (row.kind === "assistantText" || row.kind === "reasoning") &&
      row.state === "streaming"
    )
      row.state = "interrupted";
    if (row.kind === "turnHeader" && row.state === "running") {
      row.state = "completedInterrupted";
      row.endedAt = at;
    }
    if (
      row.kind === "toolCall" &&
      ["running", "inputStreaming", "pendingApproval"].includes(row.status)
    ) {
      row.status = "cancelled";
      row.endedAt = at;
    }
    if (row.kind === "subagent" && row.status === "running") {
      row.status = "cancelled";
      row.endedAt = at;
    }
  }
  if (snapshot.subagents) {
    snapshot.subagents.endedTotal += snapshot.subagents.running.length;
    snapshot.subagents.running = [];
    snapshot.subagents.revision += 1;
  }
}

function completeSnapshot(snapshot: Snapshot, at: number) {
  snapshot.control = {
    ...snapshot.control,
    phase: "completedSuccess",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    activeWorks: [],
  };
  snapshot.inputRouting = { mode: "startNow" };
  for (const row of snapshot.rows.window) {
    if (
      (row.kind === "assistantText" || row.kind === "reasoning") &&
      row.state === "streaming"
    )
      row.state = "complete";
    if (row.kind === "turnHeader" && row.state === "running") {
      row.state = "completedSuccess";
      row.endedAt = at;
    }
  }
}

function completeTool(
  snapshot: Snapshot,
  event: Extract<StreamEvent, { type: "tool.completed" }>,
  at: number,
) {
  const row = snapshot.rows.window.find(
    (row) =>
      row.kind === "toolCall" &&
      row.toolCallId === `${event.runId}/${event.toolCallId}`,
  );
  if (row?.kind !== "toolCall" || row.status !== "running") return;
  const text =
    event.outputText ??
    (event.output ? JSON.stringify(event.output) : (event.outputSummary ?? ""));
  const display = protocol.toolCallDisplaySchema.safeParse(
    event.output?.display,
  );
  Object.assign(
    row,
    protocol.toolCallRowSchema.parse({
      ...row,
      status: event.status ?? "success",
      output: { text, ...(display.success ? { display: display.data } : {}) },
      ...(event.status === "error"
        ? { error: { code: "tool_failed", message: text || "工具执行失败" } }
        : {}),
      endedAt: at,
    }),
  );
}

function finishChild(
  parent: Snapshot,
  child: Snapshot,
  toolCallId: string,
  event: Extract<StreamEvent, { type: "tool.completed" }>,
  at: number,
) {
  const row = parent.rows.window.find(
    (row) => row.kind === "subagent" && row.parentToolCallId === toolCallId,
  );
  if (row?.kind !== "subagent" || row.status !== "running") return;
  row.status =
    event.status === "error"
      ? "failed"
      : event.status === "cancelled"
        ? "cancelled"
        : "success";
  row.summaryText = event.outputSummary ?? event.outputText ?? "";
  row.endedAt = at;
  child.seq += 1;
  child.revision += 1;
  child.control = {
    ...child.control,
    phase:
      row.status === "failed"
        ? "error"
        : row.status === "cancelled"
          ? "completedInterrupted"
          : "completedSuccess",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    activeWorks: [],
  };
  for (const content of child.rows.window) {
    if (content.kind === "assistantText" || content.kind === "reasoning")
      content.state = row.status === "cancelled" ? "interrupted" : "complete";
  }
  if (parent.subagents) {
    parent.subagents.running = parent.subagents.running.filter(
      (entry) => entry.childSessionId !== child.sessionId,
    );
    parent.subagents.endedTotal += 1;
    parent.subagents.revision += 1;
  }
}

function emptySnapshot(sessionId: string, config: Config): Snapshot {
  return protocol.conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: randomUUID(),
    seq: 0,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.capabilityUnavailable" },
      resumeGoal: { allowed: false, reasonCode: "guard.capabilityUnavailable" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    workflowRuns: { revision: 0, runs: [] },
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
}

/** 原 V4 会话的权威事实提供方；主与子各有快照，UI 不再从工具名猜转录归属。 */
export function createCodeUiConversation(input: {
  sessionId: string;
  workspacePath: string;
  config: z.input<typeof protocol.sessionConfigStateSchema>;
  clock?: () => number;
  state?: CodeUiConversationState;
}) {
  const clock = input.clock ?? Date.now;
  const snapshots = new Map<string, Snapshot>();
  const childByDispatch = new Map<string, string>();
  const closedRuns = new Set(input.state?.closedRuns ?? []);
  const config = protocol.sessionConfigStateSchema.parse(input.config);
  if (input.state) {
    if (input.state.version !== 1) throw new Error("Code 会话状态版本不匹配");
    for (const snapshot of input.state.snapshots)
      snapshots.set(
        snapshot.sessionId,
        protocol.conversationSnapshotSchema.parse(snapshot),
      );
    for (const [key, childId] of input.state.dispatches)
      childByDispatch.set(key, childId);
  }
  const root =
    snapshots.get(input.sessionId) ?? emptySnapshot(input.sessionId, config);
  snapshots.set(root.sessionId, root);
  let runId = input.state?.runId ?? "";

  const requireSnapshot = (sessionId: string): Snapshot => {
    const snapshot = snapshots.get(sessionId);
    if (!snapshot) throw new Error("Code 会话不存在");
    return snapshot;
  };
  const appendRow = (snapshot: Snapshot, row: Row) => {
    snapshot.rows.window.push(row);
    snapshot.rows.totalCount = snapshot.rows.window.length;
    snapshot.rows.firstRowId ??= row.rowId;
  };
  const base = (snapshot: Snapshot, entityId: string, at: number) => ({
    rowId: (snapshot.rows.window.at(-1)?.rowId ?? 0) + 1,
    turnId: runId,
    productTurnId: runId,
    entityId,
    createdAt: at,
    createdAtSeq: snapshot.seq,
  });

  return {
    stop(
      expectedForegroundExecutionId?: string,
    ): { kind: "stopped"; runId: string } | { kind: "targetChanged" | "idle" } {
      const active = root.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      );
      if (
        expectedForegroundExecutionId !== undefined &&
        (!root.control.canStop ||
          expectedForegroundExecutionId !== active?.foregroundExecutionId)
      )
        return { kind: "targetChanged" };
      if (!root.control.canStop) return { kind: "idle" };
      this.recordEvent({
        type: "run.canceled",
        runId,
        timestamp: new Date(clock()).toISOString(),
      });
      return { kind: "stopped", runId };
    },
    exportState(): CodeUiConversationState {
      return structuredClone({
        version: 1,
        runId,
        snapshots: [...snapshots.values()],
        dispatches: [...childByDispatch.entries()],
        closedRuns: [...closedRuns],
      });
    },
    startTurn(turn: { runId: string; commandId: string; text: string }) {
      runId = turn.runId;
      const at = clock();
      if (!root.meta.title)
        root.meta = {
          title: deriveSessionTitle(turn.text),
          titleSource: "generated",
        };
      root.seq += 1;
      root.revision += 1;
      root.control = {
        ...root.control,
        phase: "running",
        sessionEnded: false,
        lastError: null,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [
          {
            kind: "primaryTurn",
            foregroundExecutionId: turn.runId,
            startedAt: at,
          },
        ],
      };
      root.inputRouting = { mode: "enqueue" };
      appendRow(root, {
        ...base(root, `turn:${runId}`, at),
        kind: "turnHeader",
        origin: "userInput",
        executionKind: "agent",
        sourceCommandId: turn.commandId,
        state: "running",
        startedAt: at,
      });
      appendRow(root, {
        ...base(root, `input:${turn.commandId}`, at),
        kind: "userInput",
        origin: "realUser",
        sourceCommandId: turn.commandId,
        rootSourceCommandId: turn.commandId,
        text: turn.text,
      });
    },
    recordEvent(event: StreamEvent) {
      if (event.runId !== runId || closedRuns.has(event.runId)) return;
      const at = Date.parse(event.timestamp);
      if (event.type === "run.canceled" || event.type === "run.failed") {
        closedRuns.add(event.runId);
        for (const snapshot of snapshots.values()) {
          if (snapshot.control.phase !== "running") continue;
          snapshot.seq += 1;
          snapshot.revision += 1;
          cancelSnapshot(snapshot, at);
          if (event.type === "run.failed")
            snapshot.control = {
              ...snapshot.control,
              phase: "error",
              sessionEnded: false,
              lastError: {
                code: event.error.code,
                message: event.error.message,
                recoverable: true,
                at,
                source: "runtime",
              },
            };
        }
        return;
      }
      if (event.type === "run.completed") {
        closedRuns.add(event.runId);
        root.seq += 1;
        root.revision += 1;
        completeSnapshot(root, at);
        return;
      }
      const dispatchId = "agentCallId" in event ? event.agentCallId : undefined;
      const childSessionId = dispatchId
        ? childByDispatch.get(`${event.runId}/${dispatchId}`)
        : undefined;
      if (dispatchId && !childSessionId)
        throw new Error("子代理事件缺少已登记派发身份");
      const snapshot = requireSnapshot(childSessionId ?? root.sessionId);
      if (
        event.type === "tool.started" &&
        snapshot.rows.window.some(
          (row) =>
            row.kind === "toolCall" &&
            row.toolCallId === `${event.runId}/${event.toolCallId}`,
        )
      )
        return;
      snapshot.seq += 1;
      snapshot.revision += 1;

      if (event.type === "tool.started") {
        const toolCallId = `${event.runId}/${event.toolCallId}`;
        const isDispatch = [
          "subagent_task",
          "subagent_background",
          "task_background",
        ].includes(event.toolName);
        const toolInput = fileToolInput(input.workspacePath, event);
        appendRow(snapshot, {
          ...base(snapshot, `tool:${toolCallId}`, at),
          kind: "toolCall",
          toolCallId,
          toolName: isDispatch ? "Agent" : event.toolName,
          status: "running",
          inputText: JSON.stringify(toolInput ?? {}),
          input: toolInput,
          startedAt: at,
        });
        if (!isDispatch) return;
        const childId = randomUUID();
        childByDispatch.set(toolCallId, childId);
        const child = emptySnapshot(childId, config);
        child.control = {
          ...child.control,
          phase: "running",
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
        };
        child.meta = {
          title: String(event.input?.description ?? ""),
          titleSource: "generated",
        };
        snapshots.set(childId, child);
        const subagentType = String(event.input?.subagent_type ?? "");
        appendRow(snapshot, {
          ...base(snapshot, `subagent:${childId}`, at),
          kind: "subagent",
          parentToolCallId: toolCallId,
          childSessionId: childId,
          subagentType,
          status: "running",
          summaryText: child.meta.title,
          startedAt: at,
        });
        snapshot.subagents = {
          revision: (snapshot.subagents?.revision ?? 0) + 1,
          childSessionIds: [
            ...(snapshot.subagents?.childSessionIds ?? []),
            childId,
          ],
          running: [
            ...(snapshot.subagents?.running ?? []),
            {
              childSessionId: childId,
              toolCallId,
              subagentType,
              title: child.meta.title,
              status: "running",
              startedAt: at,
            },
          ],
          endedTotal: snapshot.subagents?.endedTotal ?? 0,
        };
        return;
      }
      if (event.type === "message.delta" || event.type === "thinking.delta") {
        const kind =
          event.type === "thinking.delta" ? "reasoning" : "assistantText";
        const entityId = `${kind}:${event.runId}/${event.messageId}`;
        const existing = snapshot.rows.window.find(
          (row) => row.entityId === entityId && row.kind === kind,
        );
        if (
          existing?.kind === "assistantText" ||
          existing?.kind === "reasoning"
        )
          existing.text += event.delta;
        else
          appendRow(snapshot, {
            ...base(snapshot, entityId, at),
            kind,
            assistantResponseId: event.messageId,
            state: "streaming",
            text: event.delta,
          });
      }
      if (event.type === "tool.completed") {
        completeTool(snapshot, event, at);
        const childId = childByDispatch.get(
          `${event.runId}/${event.toolCallId}`,
        );
        if (childId && event.toolName === "subagent_task")
          finishChild(
            snapshot,
            requireSnapshot(childId),
            `${event.runId}/${event.toolCallId}`,
            event,
            at,
          );
      }
    },
    getSnapshot(sessionId = input.sessionId): Snapshot {
      return protocol.conversationSnapshotSchema.parse(
        structuredClone(requireSnapshot(sessionId)),
      );
    },
  };
}
