import { randomUUID } from "node:crypto";
import {
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import type { z } from "zod";
import { deriveSessionTitle } from "../chat/session-title.js";
import type { ApprovalEvent } from "../permissions/approval-types.js";
import type { RunUsageTotals } from "../usage/run-usage-accumulator.js";
import { updateTurnFileSummary } from "./file-changes.js";
import { type CodeAdmittedInput, codeGuideMessageId } from "./input-intents.js";
import { codeInputRouting, resolveHeldQueue } from "./queue-control.js";
import type { UserInputEvent } from "./user-input-types.js";

type Snapshot = protocol.ConversationSnapshot;
type Row = protocol.ConversationRow;
type Config = protocol.SessionConfigState;
type ExecutionStart = {
  runId: string;
  commandId: string;
  modelSelection?: NonNullable<Config["modelSelection"]>;
  mode?: string | undefined;
  planEnabled?: boolean | undefined;
};

function setManualCompactStatus(
  snapshot: Snapshot,
  runId: string,
  status: Extract<
    protocol.TimelineMarkerPayload,
    { type: "compact" }
  >["status"],
) {
  const row = snapshot.rows.window.find(
    (entry) => entry.entityId === `compact:${runId}`,
  );
  if (
    row?.kind !== "timelineMarker" ||
    row.marker.type !== "compact" ||
    row.marker.origin !== "manual"
  )
    throw new Error("手动压缩缺少已登记的维护操作标记");
  row.marker.status = status;
}

export interface CodeUiConversationState {
  version: 1;
  runId: string;
  snapshots: Snapshot[];
  dispatches: Array<[string, string]>;
  closedRuns: string[];
  detachedChildSessionIds?: string[];
  inputs?: CodeAdmittedInput[];
  inputOwner?: { hostId: string; runtimeId: string };
  runUsage?: Array<[string, RunUsageTotals]>;
  childRunUsage?: Array<[string, Array<[string, RunUsageTotals]>]>;
}

function cancelToolWaits(snapshot: Snapshot, at: number) {
  snapshot.pendingInteractions = [];
  for (const row of snapshot.rows.window) {
    if (
      row.kind === "toolCall" &&
      ["running", "inputStreaming", "pendingApproval"].includes(row.status)
    ) {
      row.status = "cancelled";
      row.endedAt = at;
    }
  }
}

function cancelSnapshot(
  snapshot: Snapshot,
  at: number,
  retained = new Set<string>(),
) {
  snapshot.control = {
    ...snapshot.control,
    phase: "completedInterrupted",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    activeWorks: [],
  };
  snapshot.inputRouting = codeInputRouting(snapshot);
  cancelToolWaits(snapshot, at);
  for (const row of snapshot.rows.window) {
    if (
      (row.kind === "assistantText" || row.kind === "reasoning") &&
      row.state === "streaming"
    )
      row.state = "interrupted";
    if (row.kind === "turnHeader" && row.state === "running") {
      row.state = "completedInterrupted";
      row.endedAt = at;
      for (const segment of row.workSegments ?? []) segment.endedAt ??= at;
    }
    if (
      row.kind === "subagent" &&
      row.status === "running" &&
      (!row.childSessionId || !retained.has(row.childSessionId))
    ) {
      row.status = "cancelled";
      row.endedAt = at;
    }
  }
  if (snapshot.subagents) {
    const running = snapshot.subagents.running.filter((child) =>
      retained.has(child.childSessionId),
    );
    snapshot.subagents.endedTotal +=
      snapshot.subagents.running.length - running.length;
    snapshot.subagents.running = running;
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
  snapshot.inputRouting = codeInputRouting(snapshot);
  for (const row of snapshot.rows.window) {
    if (
      (row.kind === "assistantText" || row.kind === "reasoning") &&
      row.state === "streaming"
    )
      row.state = "complete";
    if (row.kind === "turnHeader" && row.state === "running") {
      row.state = "completedSuccess";
      row.endedAt = at;
      for (const segment of row.workSegments ?? []) segment.endedAt ??= at;
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
  if (
    row?.kind !== "toolCall" ||
    !["running", "pendingApproval"].includes(row.status)
  )
    return;
  const text =
    event.outputText ??
    (event.output ? JSON.stringify(event.output) : (event.outputSummary ?? ""));
  const output = protocol.toolOutputSchema.safeParse({
    text,
    ...(event.output?.display ? { display: event.output.display } : {}),
  });
  Object.assign(
    row,
    protocol.toolCallRowSchema.parse({
      ...row,
      status: event.status ?? "success",
      output: output.success ? output.data : { text },
      ...(event.status === "error"
        ? { error: { code: "tool_failed", message: text || "工具执行失败" } }
        : {}),
      endedAt: at,
    }),
  );
  updateTurnFileSummary(snapshot, row.turnId);
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
  if (row.status === "failed" || row.status === "cancelled")
    cancelToolWaits(child, at);
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
  const detachedChildren = new Set(input.state?.detachedChildSessionIds ?? []);
  const inputs = structuredClone(input.state?.inputs ?? []);
  let inputOwner = input.state?.inputOwner;
  const runUsage = new Map(input.state?.runUsage ?? []);
  const childRunUsage = new Map(input.state?.childRunUsage ?? []);
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
  const beginExecution = (turn: ExecutionStart) => {
    runId = turn.runId;
    root.config = protocol.sessionConfigStateSchema.parse({
      ...root.config,
      ...(turn.modelSelection !== undefined
        ? { modelSelection: turn.modelSelection }
        : {}),
      ...(turn.mode !== undefined ? { mode: turn.mode } : {}),
      ...(turn.planEnabled !== undefined
        ? { planEnabled: turn.planEnabled }
        : {}),
    });
    const at = clock();
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
    return at;
  };

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
        detachedChildSessionIds: [...detachedChildren],
        inputs,
        runUsage: [...runUsage],
        childRunUsage: [...childRunUsage],
        ...(inputOwner ? { inputOwner } : {}),
      });
    },
    setInputOwner(owner: { hostId: string; runtimeId: string }) {
      inputOwner = { ...owner };
    },
    resolveHeldQueue(payload: Parameters<typeof resolveHeldQueue>[2]) {
      return resolveHeldQueue(root, inputs, payload);
    },
    admitInput(
      record: CodeAdmittedInput,
      owner?: { hostId: string; runtimeId: string },
    ) {
      if (owner) inputOwner = { ...owner };
      inputs.push(structuredClone(record));
      if (record.status === "queued") {
        root.queue.items.push(protocol.queueItemSchema.parse(record.intent));
        root.seq += 1;
        root.revision += 1;
      } else if (record.status === "reserved") {
        root.pendingCommands.push({
          commandId: record.intent.sourceCommandId,
          clientId: record.intent.clientId,
          type: record.intent.kind,
          state: "executing",
          at: record.intent.admittedAt,
        });
        root.seq += 1;
        root.revision += 1;
      }
    },
    promoteReservedInput(runId: string): CodeAdmittedInput | undefined {
      if (root.control.phase === "running") return;
      const record = inputs.find(
        (entry) => entry.status === "reserved" && entry.runId === runId,
      );
      if (!record) return;
      record.status = "active";
      root.pendingCommands = root.pendingCommands.filter(
        (entry) =>
          entry.commandId !== record.intent.sourceCommandId ||
          entry.clientId !== record.intent.clientId,
      );
      if (root.queue.pauseReason !== "manual") {
        root.queue.autoDrain =
          record.autoDrainAtAdmission ?? root.queue.autoDrain;
        if (root.queue.autoDrain) delete root.queue.pauseReason;
      }
      this.startInput(record);
      return structuredClone(record);
    },
    promoteQueuedInput(
      scopeGeneration: number,
      branchGeneration: number,
      reservationId: string,
    ): CodeAdmittedInput | undefined {
      if (
        root.control.phase === "running" ||
        !root.queue.autoDrain ||
        !root.queue.items.length
      )
        return;
      const item = root.queue.items[0]!;
      const record = inputs.find(
        (entry) =>
          entry.status === "queued" &&
          entry.intent.queueItemId === item.queueItemId,
      );
      if (
        !record ||
        record.scopeGeneration !== scopeGeneration ||
        record.branchGeneration !== branchGeneration
      ) {
        root.queue.autoDrain = false;
        root.queue.pauseReason = "error";
        root.seq += 1;
        root.revision += 1;
        return;
      }
      root.queue.items.shift();
      record.status = "active";
      record.intent.dispatch = { state: "promoting", reservationId };
      this.startInput(record);
      return structuredClone(record);
    },
    recordApprovalEvent(event: ApprovalEvent) {
      this.recordInteractionEvent(event);
    },
    recordInteractionEvent(event: ApprovalEvent | UserInputEvent) {
      const target = requireSnapshot(
        event.identity.agentId === "main"
          ? event.identity.taskId
          : event.identity.agentId,
      );
      const toolCallId = `${event.identity.runId}/${event.identity.toolCallId}`;
      const row = target.rows.window.find(
        (entry) => entry.kind === "toolCall" && entry.toolCallId === toolCallId,
      );
      target.pendingInteractions = target.pendingInteractions.filter(
        (entry) => entry.interactionId !== event.interaction.interactionId,
      );
      if (event.type === "requested") {
        const interaction = structuredClone(event.interaction);
        interaction.anchorRowId = row?.rowId ?? null;
        if (interaction.payload.kind === "permission")
          interaction.payload.toolCallId = toolCallId;
        target.pendingInteractions.push(interaction);
      }
      if (
        row?.kind === "toolCall" &&
        ["running", "pendingApproval"].includes(row.status)
      ) {
        row.status =
          event.type === "requested"
            ? "pendingApproval"
            : event.type === "resolved" &&
                (!("decision" in event) || event.decision === "allow")
              ? "running"
              : event.interaction.kind === "userInput"
                ? "cancelled"
                : "error";
        if (row.status === "error")
          row.error = {
            code: "tool_denied",
            message:
              event.type === "cancelled" ? event.reason : "用户拒绝此工具调用",
          };
      }
      target.seq += 1;
      target.revision += 1;
    },
    registerChildDispatch(fact: {
      parentSessionId: string;
      parentRunId: string;
      toolCallId: string;
      childSessionId: string;
      role: string;
      title: string;
      at: number;
      detached?: boolean;
    }) {
      const key = `${fact.parentRunId}/${fact.toolCallId}`;
      const existing = childByDispatch.get(key);
      if (existing) return existing;
      const parent = requireSnapshot(fact.parentSessionId);
      const child = emptySnapshot(fact.childSessionId, parent.config);
      child.meta = { title: fact.title, titleSource: "generated" };
      child.control = {
        ...child.control,
        phase: "running",
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
      };
      snapshots.set(child.sessionId, child);
      if (fact.detached) detachedChildren.add(child.sessionId);
      childByDispatch.set(key, child.sessionId);
      parent.seq += 1;
      parent.revision += 1;
      appendRow(parent, {
        ...base(parent, `subagent:${child.sessionId}`, fact.at),
        turnId: fact.parentRunId,
        productTurnId: fact.parentRunId,
        kind: "subagent",
        parentToolCallId: key,
        childSessionId: child.sessionId,
        subagentType: fact.role,
        status: "running",
        summaryText: fact.title,
        startedAt: fact.at,
      });
      parent.subagents = {
        revision: (parent.subagents?.revision ?? 0) + 1,
        childSessionIds: [
          ...(parent.subagents?.childSessionIds ?? []),
          child.sessionId,
        ],
        running: [
          ...(parent.subagents?.running ?? []),
          {
            childSessionId: child.sessionId,
            toolCallId: key,
            subagentType: fact.role,
            title: fact.title,
            status: "running",
            startedAt: fact.at,
          },
        ],
        endedTotal: parent.subagents?.endedTotal ?? 0,
      };
      return child.sessionId;
    },
    recordChildRunEvent(childSessionId: string, event: StreamEvent) {
      if (childSessionId === input.sessionId)
        throw new Error("子运行不能写入主转录目标");
      const child = requireSnapshot(childSessionId);
      if (child.control.phase !== "running") return;
      if (closedRuns.has(event.runId)) return;
      const descendants = new Set([childSessionId]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const snapshot of snapshots.values())
          if (descendants.has(snapshot.sessionId))
            for (const row of snapshot.rows.window)
              if (
                row.kind === "subagent" &&
                row.childSessionId &&
                !descendants.has(row.childSessionId)
              ) {
                descendants.add(row.childSessionId);
                changed = true;
              }
      }
      const host = createCodeUiConversation({
        sessionId: childSessionId,
        workspacePath: input.workspacePath,
        config: child.config,
        state: {
          version: 1,
          runId: event.runId,
          runUsage: childRunUsage.get(childSessionId) ?? [],
          childRunUsage: [...childRunUsage].filter(([id]) => descendants.has(id)),
          snapshots: [...snapshots.values()].filter((snapshot) =>
            descendants.has(snapshot.sessionId),
          ),
          dispatches: [...childByDispatch],
          closedRuns: [...closedRuns],
          detachedChildSessionIds: [...detachedChildren].filter((id) =>
            descendants.has(id),
          ),
        },
      });
      if (!child.rows.window.some((row) => row.kind === "turnHeader"))
        host.startTurn({
          runId: event.runId,
          commandId: `child:${childSessionId}`,
          text: child.meta.title ?? "子任务",
        });
      host.recordEvent(event);
      const state = host.exportState();
      childRunUsage.set(childSessionId, state.runUsage ?? []);
      for (const [id, usage] of state.childRunUsage ?? [])
        childRunUsage.set(id, usage);
      for (const snapshot of state.snapshots)
        snapshots.set(snapshot.sessionId, snapshot);
      if (!["run.completed", "run.failed", "run.canceled"].includes(event.type))
        return;
      closedRuns.add(event.runId);
      const updated = requireSnapshot(childSessionId);
      for (const parent of snapshots.values()) {
        const row = parent.rows.window.find(
          (entry) =>
            entry.kind === "subagent" &&
            entry.childSessionId === childSessionId,
        );
        if (row?.kind !== "subagent" || !row.parentToolCallId) continue;
        const text = updated.rows.window
          .filter((entry) => entry.kind === "assistantText")
          .map((entry) => entry.text)
          .join("\n");
        finishChild(
          parent,
          updated,
          row.parentToolCallId,
          {
            type: "tool.completed",
            runId: event.runId,
            toolCallId: row.parentToolCallId,
            toolName: "Task",
            timestamp: event.timestamp,
            status:
              event.type === "run.failed"
                ? "error"
                : event.type === "run.canceled"
                  ? "cancelled"
                  : "success",
            outputSummary: text,
          },
          Date.parse(event.timestamp),
        );
        parent.seq += 1;
        parent.revision += 1;
      }
    },
    consumeGuides(ids: ReadonlySet<string>) {
      const header = root.rows.window.find(
        (row) => row.kind === "turnHeader" && row.turnId === runId,
      );
      if (header?.kind !== "turnHeader" || header.state !== "running")
        throw new Error("指导所属轮次已结束。");
      for (const record of inputs) {
        const entityId = codeGuideMessageId(record);
        if (
          !ids.has(entityId) ||
          record.runId !== runId ||
          record.status !== "queued" ||
          record.intent.delivery.admitted !== "guide"
        )
          continue;
        const at = clock();
        record.status = "settled";
        record.intent.steer = { state: "guided" };
        record.intent.dispatch = { state: "drained" };
        root.queue.items = root.queue.items.filter(
          (item) => item.queueItemId !== record.intent.queueItemId,
        );
        header.workSegments ??= [
          { segmentId: header.entityId ?? `turn:${runId}`, startedAt: header.startedAt },
        ];
        const previous = header.workSegments.at(-1);
        if (previous) previous.endedAt = at;
        header.workSegments.push({ segmentId: entityId, triggerEntityId: entityId, startedAt: at });
        header.sourceCommandId = record.intent.sourceCommandId;
        root.seq += 1;
        root.revision += 1;
        appendRow(root, {
          ...base(root, entityId, at),
          kind: "userInput",
          origin: "realUser",
          guided: true,
          sourceCommandId: record.intent.sourceCommandId,
          rootSourceCommandId: record.intent.provenance?.sourceCommandId ?? record.intent.sourceCommandId,
          clientId: record.intent.clientId,
          text: record.intent.text,
        });
      }
    },
    startInput(record: CodeAdmittedInput) {
      const execution = {
        runId: record.runId,
        commandId: record.intent.sourceCommandId,
        modelSelection: record.intent.modelSelection!,
        mode: record.intent.planEnabled ? "plan" : record.intent.mode,
        planEnabled: record.intent.planEnabled,
      };
      if (record.intent.kind === "compact") {
        const at = beginExecution(execution);
        appendRow(root, {
          ...base(root, `compact:${record.runId}`, at),
          kind: "timelineMarker",
          sourceCommandId: record.intent.sourceCommandId,
          lane: "assistantWork",
          marker: { type: "compact", origin: "manual", status: "running" },
        });
      } else
        this.startTurn({
          ...execution,
          clientId: record.intent.clientId,
          ...(record.historyOf
            ? {
                origin:
                  record.historyOf.action === "editUserQuery"
                    ? ("editRerun" as const)
                    : ("userInput" as const),
                rootSourceCommandId: record.historyOf.rootSourceCommandId,
              }
            : {}),
          text: record.intent.text,
          attachments: record.intent.attachments,
        });
    },
    startTurn(turn: {
      runId: string;
      commandId: string;
      text: string;
      attachments?: protocol.AttachmentRef[];
      clientId?: string;
      mode?: string | undefined;
      planEnabled?: boolean | undefined;
      origin?: "userInput" | "backgroundResult" | "editRerun";
      rootSourceCommandId?: string;
      modelSelection?: NonNullable<
        protocol.SessionConfigState["modelSelection"]
      >;
    }) {
      const at = beginExecution(turn);
      if (!root.meta.title && turn.origin !== "backgroundResult")
        root.meta = {
          title: deriveSessionTitle(turn.text),
          titleSource: "generated",
        };
      appendRow(root, {
        ...base(root, `turn:${runId}`, at),
        kind: "turnHeader",
        origin: turn.origin ?? "userInput",
        executionKind: "agent",
        sourceCommandId: turn.commandId,
        state: "running",
        startedAt: at,
      });
      appendRow(root, {
        ...base(root, `input:${turn.commandId}`, at),
        kind: "userInput",
        origin:
          turn.origin === "backgroundResult" ? "backgroundResult" : "realUser",
        sourceCommandId: turn.commandId,
        rootSourceCommandId: turn.rootSourceCommandId ?? turn.commandId,
        ...(turn.clientId ? { clientId: turn.clientId } : {}),
        ...(turn.attachments?.length
          ? { attachments: structuredClone(turn.attachments) }
          : {}),
        text: turn.text,
      });
    },
    recordEvent(event: StreamEvent) {
      if (event.type === "task.work") {
        if (event.work.taskId !== input.sessionId) return;
        const work = event.work;
        root.seq += 1;
        root.revision += 1;
        root.backgroundWorks = root.backgroundWorks.filter(
          (entry) => entry.workId !== work.workId,
        );
        if (
          work.kind === "subagent" &&
          work.childSessionId &&
          work.status !== "running"
        ) {
          const child = snapshots.get(work.childSessionId);
          if (child)
            for (const parent of snapshots.values()) {
              const dispatch = parent.rows.window.find(
                (row) =>
                  row.kind === "subagent" &&
                  row.childSessionId === work.childSessionId,
              );
              if (dispatch?.kind !== "subagent" || !dispatch.parentToolCallId)
                continue;
              finishChild(
                parent,
                child,
                dispatch.parentToolCallId,
                {
                  type: "tool.completed",
                  runId: work.originRunId,
                  toolCallId: work.toolCallId,
                  toolName: "Task",
                  timestamp: event.timestamp,
                  status:
                    work.status === "failed"
                      ? "error"
                      : work.status === "canceled" ||
                          work.status === "interrupted"
                        ? "cancelled"
                        : "success",
                  outputSummary: work.summary ?? work.status,
                },
                Date.parse(event.timestamp),
              );
              if (parent !== root) {
                parent.seq += 1;
                parent.revision += 1;
              }
            }
        }
        if (work.detached === false) return;
        if (!work.consumed) {
          const anchor = root.rows.window.find(
            (row) =>
              row.kind === "toolCall" &&
              row.toolCallId === `${work.originRunId}/${work.toolCallId}`,
          );
          root.backgroundWorks.push({
            workId: work.workId,
            kind: work.kind === "command" ? "bash" : "subagent",
            title: work.label,
            status:
              work.status === "running"
                ? "running"
                : work.status === "failed"
                  ? "failed"
                  : work.status === "canceled" || work.status === "interrupted"
                    ? "cancelled"
                    : "resultPending",
            startedAt: Date.parse(work.startedAt),
            ...(work.endedAt ? { endedAt: Date.parse(work.endedAt) } : {}),
            cancellable: work.status === "running",
            anchorRowId: anchor?.rowId ?? null,
            ...(work.childSessionId
              ? { childSessionId: work.childSessionId }
              : {}),
          });
        } else if (
          work.status !== "running" &&
          !root.rows.window.some(
            (row) => row.entityId === `work-result:${work.workId}`,
          )
        ) {
          appendRow(root, {
            ...base(
              root,
              `work-result:${work.workId}`,
              Date.parse(event.timestamp),
            ),
            kind: "userInput",
            origin: "backgroundResult",
            text: `${work.label}\n${work.summary ?? work.status}`,
            originMeta: {
              backgroundSource: work.kind === "command" ? "bash" : "subagent",
              workId: work.workId,
            },
          });
        }
        return;
      }
      if (event.runId !== runId || closedRuns.has(event.runId)) return;
      if (event.type === "run.usage") {
        if (
          event.runInputTokens === undefined ||
          event.runOutputTokens === undefined
        )
          return;
        const cached =
          event.runCachedInputTokens ??
          runUsage.get(event.runId)?.cachedInputTokens;
        runUsage.set(event.runId, {
          inputTokens: event.runInputTokens,
          outputTokens: event.runOutputTokens,
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        });
        root.usage.cumulative = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: root.usage.cumulative.cacheWriteTokens,
        };
        for (const usage of runUsage.values()) {
          root.usage.cumulative.inputTokens += usage.inputTokens;
          root.usage.cumulative.outputTokens += usage.outputTokens;
          root.usage.cumulative.cacheReadTokens += usage.cachedInputTokens ?? 0;
        }
        root.seq += 1;
        root.revision += 1;
        return;
      }
      if (
        ["run.completed", "run.failed", "run.canceled"].includes(event.type)
      ) {
        // 未到模型边界的指导仍是原canonical输入；转回普通队列，不能复用已关闭Run。
        for (const guide of inputs) {
          if (
            guide.runId !== event.runId || guide.status !== "queued" ||
            guide.intent.delivery.admitted !== "guide"
          ) continue;
          const reasonCode = event.type === "run.completed"
            ? "guide.noToolBoundary" : "guide.turnInterrupted";
          guide.runId = randomUUID();
          guide.intent.delivery = { ...guide.intent.delivery, admitted: "queue", fallbackReasonCode: reasonCode };
          guide.intent.steer = { state: "fellBack", reasonCode };
          const index = root.queue.items.findIndex((item) => item.queueItemId === guide.intent.queueItemId);
          if (index >= 0) root.queue.items[index] = protocol.queueItemSchema.parse(guide.intent);
        }
        const active = inputs.find(
          (entry) => entry.runId === event.runId && entry.status === "active",
        );
        if (active) {
          active.status = "settled";
          active.intent.dispatch = { state: "drained" };
        }
        if (event.type !== "run.completed") {
          root.queue.autoDrain = false;
          root.queue.pauseReason =
            event.type === "run.canceled" ? "stopped" : "error";
        }
      }
      const at = Date.parse(event.timestamp);
      if (event.type === "run.canceled" || event.type === "run.failed") {
        if (
          inputs.some(
            (input) =>
              input.runId === event.runId && input.intent.kind === "compact",
          )
        )
          setManualCompactStatus(
            root,
            event.runId,
            event.type === "run.failed" ? "failed" : "cancelled",
          );
        closedRuns.add(event.runId);
        const retained = new Set(detachedChildren);
        // 保留 detached 的整个后代树，包括其前台子任务。
        for (let changed = true; changed; ) {
          changed = false;
          for (const snapshot of snapshots.values())
            if (retained.has(snapshot.sessionId))
              for (const row of snapshot.rows.window)
                if (
                  row.kind === "subagent" &&
                  row.childSessionId &&
                  !retained.has(row.childSessionId)
                ) {
                  retained.add(row.childSessionId);
                  changed = true;
                }
        }
        for (const snapshot of snapshots.values()) {
          if (retained.has(snapshot.sessionId)) continue;
          if (snapshot.control.phase !== "running") continue;
          snapshot.seq += 1;
          snapshot.revision += 1;
          cancelSnapshot(snapshot, at, retained);
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
        if (event.operationResult?.kind === "compact")
          setManualCompactStatus(
            root,
            event.runId,
            event.operationResult.status === "applied" ? "success" : "noop",
          );
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
        const toolInput = event.input;
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
        const pending = snapshot.pendingInteractions.find(
          (interaction) =>
            (interaction.payload.kind === "permission" &&
              interaction.payload.toolCallId === toolCallId) ||
            (interaction.payload.kind === "userInput" &&
              interaction.payload.traceId === event.runId &&
              interaction.payload.toolCallId === event.toolCallId),
        );
        const toolRow = snapshot.rows.window.at(-1);
        if (pending && toolRow?.kind === "toolCall") {
          pending.anchorRowId = toolRow.rowId;
          toolRow.status = "pendingApproval";
        }
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
      if (event.type === "run.compacted") {
        if (event.origin === "manual") {
          setManualCompactStatus(snapshot, event.runId, "success");
          return;
        }
        appendRow(snapshot, {
          ...base(snapshot, `compact:${event.runId}/${snapshot.seq}`, at),
          kind: "timelineMarker",
          lane: "assistantWork",
          marker: { type: "compact", origin: "auto", status: "success" },
        });
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
