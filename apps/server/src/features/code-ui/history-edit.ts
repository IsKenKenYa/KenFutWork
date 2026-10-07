import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { TrustedCodeInput } from "./attachments/input-types.js";
import { createCodeUiConversation } from "./conversation.js";
import type { CodeAdmittedInput } from "./input-intents.js";
import {
  captureHistoryFileChanges,
  createCodeUiOwnedHistory,
  mappedHistoryBoundaries,
  rebindOwnedHistory,
} from "./owned-history.js";
import type {
  CodeReplayInput,
  CodeUiOwnedHistoryTurn,
} from "./owned-history-types.js";
import {
  CodeUiRepositoryError,
  type CodeUiSessionRecord,
} from "./repository.js";
import type { CodeUiService, CodeUiServiceDeps } from "./service.js";

type Loaded = Awaited<ReturnType<CodeUiService["loadConversation"]>>;
type WorkspaceTarget = {
  workspacePath: string;
  projectId?: string;
  workspaceIdentity?: string;
};
type Guard = { baseRevision: number; baseLogEpoch: string };
type ModelPlan = {
  selection: NonNullable<protocol.SessionConfigState["modelSelection"]>;
  modelInvocation: CodeAdmittedInput["modelInvocation"];
};
type Deps = Pick<
  CodeUiServiceDeps,
  "repository" | "agentRuns" | "agentRunMetadata" | "threads" | "settings"
> & {
  inputOwner: { hostId: string; runtimeId: string };
  load(actor: LocalActor, sessionId: string): Promise<Loaded>;
  model(
    actor: LocalActor,
    selection: protocol.SessionConfigState["modelSelection"],
  ): Promise<ModelPlan>;
  inputs(
    actor: LocalActor,
    sessionId: string,
    attachments: protocol.AttachmentRef[],
  ): Promise<TrustedCodeInput[]>;
  beginRestore(
    actor: LocalActor,
    taskId: string,
    generation: number,
    guard: Guard,
  ): Promise<ExecutionScopeHandle>;
  finishRestore(
    scope: ExecutionScopeHandle,
    actor: LocalActor,
    success: boolean,
  ): Promise<void>;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
  run(
    actor: LocalActor,
    project: Loaded["project"],
    taskId: string,
    threadId: string,
    record: CodeAdmittedInput,
    inputs: TrustedCodeInput[],
  ): Promise<void>;
  fingerprint(envelope: protocol.CommandEnvelope): string;
};

function latestEditableInput(
  root: CodeUiSessionRecord,
  snapshot: protocol.ConversationSnapshot,
) {
  if (
    root.archived ||
    root.execution_state !== "ready" ||
    root.active_run_id ||
    snapshot.control.canStop ||
    snapshot.queue.items.length ||
    snapshot.subagents?.running.length ||
    snapshot.backgroundWorks.some((work) => work.status === "running")
  )
    return null;
  for (let index = snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const row = snapshot.rows.window[index];
    if (row?.kind === "userInput" && row.origin === "realUser") return row;
  }
  return null;
}

function latestRetryInput(
  root: CodeUiSessionRecord,
  snapshot: protocol.ConversationSnapshot,
) {
  if (
    !latestEditableInput(root, snapshot) ||
    snapshot.pendingInteractions.length
  )
    return null;
  const assistant = [...snapshot.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText");
  if (assistant?.kind !== "assistantText" || assistant.state !== "complete")
    return null;
  const header = snapshot.rows.window.find(
    (row) => row.kind === "turnHeader" && row.turnId === assistant.turnId,
  );
  if (header?.kind !== "turnHeader" || header.state === "running") return null;
  const row = snapshot.rows.window.find(
    (row) =>
      row.kind === "userInput" &&
      row.origin === "realUser" &&
      row.turnId === assistant.turnId,
  );
  return row?.kind === "userInput" ? { row, assistant } : null;
}

function validBoundary(
  row: protocol.ConversationSnapshot["rows"]["window"][number],
  turn: CodeUiOwnedHistoryTurn | null,
) {
  if (
    !turn ||
    row.kind !== "userInput" ||
    turn.context.pre.status !== "captured" ||
    !turn.canonical ||
    turn.canonical.intent.sourceCommandId !== row.sourceCommandId ||
    turn.canonical.intent.clientId !== row.clientId
  )
    return null;
  return turn;
}

function cutLatestTurn(root: CodeUiSessionRecord, turnId: string) {
  const state = structuredClone(requireState(root));
  const snapshot = state.snapshots.find((entry) => entry.sessionId === root.id);
  if (!snapshot) throw new CodeUiRepositoryError("not_found", "根Task快照缺失");
  const start = snapshot.rows.window.findIndex(
    (row) => row.kind === "turnHeader" && row.turnId === turnId,
  );
  if (start < 0)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "原输入缺少真实轮次边界",
    );
  snapshot.rows.window = snapshot.rows.window.slice(0, start);
  const visibleTurns = new Set(snapshot.rows.window.map((row) => row.turnId));
  state.inheritedHistory = (state.inheritedHistory ?? []).filter((turn) =>
    visibleTurns.has(turn.owner.turnId),
  );
  state.completedTurnViews = (state.completedTurnViews ?? []).filter(([id]) =>
    visibleTurns.has(id),
  );
  snapshot.rows.totalCount = snapshot.rows.window.length;
  snapshot.rows.firstRowId = snapshot.rows.window[0]?.rowId ?? null;
  snapshot.logEpoch = randomUUID();
  snapshot.seq = 0;
  snapshot.revision += 1;
  snapshot.pendingInteractions = [];
  snapshot.pendingCommands = [];
  snapshot.backgroundWorks = [];
  if (snapshot.subagents) {
    const visible = new Set(
      snapshot.rows.window.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId
          ? [row.childSessionId]
          : [],
      ),
    );
    snapshot.subagents.childSessionIds =
      snapshot.subagents.childSessionIds.filter((id) => visible.has(id));
    snapshot.subagents.running = [];
    snapshot.subagents.endedTotal = visible.size;
    snapshot.subagents.revision += 1;
  }
  // 已结束的独立子转录仍是历史事实；当前目录只保留新分支可见的父工具关联。
  return state;
}

type EditPayload = ReturnType<
  typeof protocol.commandPayloadSchemas.editUserQuery.parse
>;
type RetryPayload = ReturnType<
  typeof protocol.commandPayloadSchemas.retryTurn.parse
>;
type EditableRow = Extract<
  protocol.ConversationSnapshot["rows"]["window"][number],
  { kind: "userInput" }
>;
type ContextReference = Parameters<
  Deps["agentRuns"]["cloneContextBranch"]
>[0]["reference"];
type ClonedTarget = {
  threadId: string;
  reference: Awaited<ReturnType<Deps["agentRuns"]["cloneContextBranch"]>>;
};
type PreparedEdit = {
  record: CodeAdmittedInput;
  inputs: TrustedCodeInput[];
  previousThreadId: string;
  turnId: string;
  history: CodeUiOwnedHistoryTurn[];
};
type FencedEdit = { clone: ClonedTarget; scope: ExecutionScopeHandle };
type PublicationPlan = FencedEdit & { prepared: PreparedEdit };
type EditProgress =
  | { phase: "preparing" }
  | { phase: "rejected"; reasonCode: string; message: string }
  | ({ phase: "cloned" } & Pick<FencedEdit, "clone">)
  | ({ phase: "fenced" } & FencedEdit)
  | ({ phase: "prepared" | "published" } & PublicationPlan);
type EditOperation = {
  actor: LocalActor;
  loaded: Loaded;
  envelope: protocol.CommandEnvelope;
  targetThreadId: string;
  progress: EditProgress;
  publication?: Promise<void>;
} & (
  | { kind: "editUserQuery"; payload: EditPayload }
  | { kind: "retryTurn"; payload: RetryPayload }
);
type EditSource = {
  row: EditableRow & { sourceCommandId: string };
  snapshot: protocol.ConversationSnapshot;
  threadId: string;
  reference: ContextReference;
  model: ModelPlan;
  inputs: TrustedCodeInput[];
  previousThreadId: string;
  canonical?: CodeReplayInput;
  history: CodeUiOwnedHistoryTurn[];
  sourceRunId?: string;
};

function requireState(root: CodeUiSessionRecord) {
  if (!root.state)
    throw new CodeUiRepositoryError("not_found", "根Task快照缺失");
  return root.state;
}

function requireRootSnapshot(root: CodeUiSessionRecord) {
  const snapshot = requireState(root).snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (!snapshot) throw new CodeUiRepositoryError("not_found", "根Task快照缺失");
  return snapshot;
}

async function createOperation(
  deps: Deps,
  actor: LocalActor,
  target: WorkspaceTarget,
  envelope: protocol.CommandEnvelope,
): Promise<EditOperation> {
  if (!envelope.sessionId)
    throw new CodeUiRepositoryError("not_found", "历史编辑缺少Task身份");
  const loaded = await deps.load(actor, envelope.sessionId);
  if (
    loaded.entry.parent_session_id ||
    loaded.project.path !== target.workspacePath ||
    (target.projectId && target.projectId !== loaded.project.projectId) ||
    (target.workspaceIdentity &&
      target.workspaceIdentity !==
        JSON.stringify([loaded.project.projectId, loaded.project.path]))
  )
    throw new CodeUiRepositoryError(
      "not_found",
      "历史编辑不属于该Project与根Task固定目录",
    );
  const base = {
    actor,
    loaded,
    envelope,
    targetThreadId: deps.threads.createThreadId(),
    progress: { phase: "preparing" as const },
  };
  return envelope.type === "retryTurn"
    ? {
        ...base,
        kind: "retryTurn",
        payload: protocol.commandPayloadSchemas.retryTurn.parse(
          envelope.payload,
        ),
      }
    : {
        ...base,
        kind: "editUserQuery",
        payload: protocol.commandPayloadSchemas.editUserQuery.parse(
          envelope.payload,
        ),
      };
}

function rejectOperation(
  operation: EditOperation,
  reasonCode: string,
  message: string,
): void {
  operation.progress = { phase: "rejected", reasonCode, message };
}

function selectEditTarget(
  deps: Deps,
  operation: EditOperation,
  root: CodeUiSessionRecord,
) {
  const snapshot = requireRootSnapshot(root);
  const { envelope, payload } = operation;
  if (snapshot.revision !== envelope.baseRevision) {
    rejectOperation(
      operation,
      "proto.staleRevision",
      "会话已更新，请重新编辑当前输入。",
    );
    return;
  }
  if (snapshot.logEpoch !== envelope.baseLogEpoch) {
    rejectOperation(
      operation,
      "proto.staleLogEpoch",
      "会话分支已改变，请刷新后重试。",
    );
    return;
  }
  if (
    operation.kind === "editUserQuery" &&
    operation.payload.workspaceMode === "rewind"
  ) {
    rejectOperation(
      operation,
      "guard.capabilityUnavailable",
      "聊天编辑的文件恢复尚未接通，请使用保留当前文件或独立文件恢复。",
    );
    return;
  }
  const retry =
    operation.kind === "retryTurn" ? latestRetryInput(root, snapshot) : null;
  const row =
    operation.kind === "retryTurn"
      ? retry?.row
      : latestEditableInput(root, snapshot);
  const target = operation.kind === "retryTurn" ? retry?.assistant : row;
  if (
    !row ||
    !target ||
    target.rowId !== payload.target.rowId ||
    target.entityId !== payload.target.entityId
  ) {
    rejectOperation(
      operation,
      operation.kind === "retryTurn"
        ? "guard.retryTargetUnavailable"
        : "guard.editTargetUnavailable",
      operation.kind === "retryTurn"
        ? "重试只接受根Task空闲时全时间线最新完整且有真实用户原因的回复。"
        : "请在根Task空闲且队列为空时编辑最新真实用户输入。",
    );
    return;
  }
  if (!deps.agentRuns.canCloneContextHistoryBranches?.()) {
    rejectOperation(
      operation,
      "guard.capabilityUnavailable",
      "当前Harness没有原生上下文分支能力。",
    );
    return;
  }
  return { row, snapshot };
}

async function prepareEditSource(
  deps: Deps,
  operation: EditOperation,
  root: CodeUiSessionRecord,
): Promise<EditSource | undefined> {
  const selected = selectEditTarget(deps, operation, root);
  if (!selected) return;
  const { row, snapshot } = selected;
  const resolver = createCodeUiOwnedHistory(deps);
  const turn = validBoundary(
    row,
    await resolver.resolve(operation.actor, root, row.turnId),
  );
  if (
    turn?.context.pre.status !== "captured" ||
    row.sourceCommandId === undefined
  ) {
    rejectOperation(
      operation,
      "guard.contextUnavailable",
      "原输入的持久上下文边界不可用，未改动聊天或文件。",
    );
    return;
  }
  const canonical = operation.kind === "retryTurn" ? turn.canonical : undefined;
  const originalSelection = canonical?.intent.modelSelection;
  if (
    operation.kind === "retryTurn" &&
    (!originalSelection || canonical?.intent.kind !== "sendText")
  ) {
    rejectOperation(
      operation,
      "guard.contextUnavailable",
      "原回复的canonical输入不可用，未更改Task或文件。",
    );
    return;
  }
  const attachments =
    operation.kind === "retryTurn"
      ? (canonical?.intent.attachments ?? [])
      : (operation.payload.attachments ?? row.attachments ?? []);
  const text =
    operation.kind === "retryTurn"
      ? (canonical?.intent.text ?? "")
      : operation.payload.newText;
  if (!text.trim() && !attachments.length) {
    rejectOperation(operation, "guard.emptyInput", "编辑内容不能为空。");
    return;
  }
  const [model, inputs, binding] = await Promise.all([
    canonical && originalSelection
      ? Promise.resolve({
          selection: originalSelection,
          modelInvocation: structuredClone(canonical.modelInvocation),
        })
      : deps.model(operation.actor, snapshot.config.modelSelection),
    deps.inputs(operation.actor, root.id, attachments),
    deps.threads.resolveOwnedSessionThread(operation.actor, root.id),
  ]);
  const history = await retainedHistory(
    resolver,
    operation.actor,
    root,
    snapshot,
    row.turnId,
  );
  await captureHistoryFileChanges(
    deps,
    operation.actor,
    root,
    snapshot,
    history,
  );
  return {
    row: { ...row, sourceCommandId: row.sourceCommandId },
    snapshot,
    threadId: turn.context.threadId,
    reference: turn.context.pre.reference,
    model,
    inputs,
    previousThreadId: binding.threadId,
    ...(canonical ? { canonical: structuredClone(canonical) } : {}),
    history,
    ...(turn.source.runId ? { sourceRunId: turn.source.runId } : {}),
  };
}

async function retainedHistory(
  resolver: ReturnType<typeof createCodeUiOwnedHistory>,
  actor: LocalActor,
  root: CodeUiSessionRecord,
  snapshot: protocol.ConversationSnapshot,
  turnId: string,
) {
  const start = snapshot.rows.window.findIndex(
    (entry) => entry.kind === "turnHeader" && entry.turnId === turnId,
  );
  if (start < 0)
    throw new CodeUiRepositoryError(
      "command_conflict",
      "原输入缺少真实轮次边界",
    );
  const history: CodeUiOwnedHistoryTurn[] = [];
  for (const id of new Set(
    snapshot.rows.window.slice(0, start).map((entry) => entry.turnId),
  )) {
    const retained = await resolver.resolve(actor, root, id);
    if (!retained)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "保留历史缺少当前Task持有的上下文边界，未发布新分支。",
      );
    history.push(retained);
  }
  return history;
}

function createEditedInput(
  operation: EditOperation,
  root: CodeUiSessionRecord,
  source: EditSource,
  scope: ExecutionScopeHandle,
): CodeAdmittedInput {
  return {
    runId: randomUUID(),
    modelInvocation: source.model.modelInvocation,
    scopeGeneration: scope.describe().generation,
    branchGeneration: Number(root.branch_generation) + 1,
    status: "active",
    historyOf: {
      action: operation.kind,
      rootSourceCommandId:
        source.row.rootSourceCommandId ?? source.row.sourceCommandId,
      sourceTurnId: source.row.turnId,
      ...(source.sourceRunId ? { sourceRunId: source.sourceRunId } : {}),
    },
    intent: {
      sourceCommandId: operation.envelope.commandId,
      queueItemId: randomUUID(),
      clientId: operation.envelope.clientId,
      kind: source.canonical?.intent.kind ?? "sendText",
      text:
        source.canonical?.intent.text ??
        (operation.kind === "editUserQuery" ? operation.payload.newText : ""),
      attachments: source.inputs.map((input) => input.attachment),
      modelSelection: source.model.selection,
      mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
        mode: source.canonical?.intent.mode ?? source.snapshot.config.mode,
      }).mode,
      planEnabled: source.canonical
        ? source.canonical.intent.planEnabled
        : source.snapshot.config.planEnabled,
      delivery: { requested: "startNow", admitted: "startNow" },
      order: {
        admissionSeq:
          (root.state?.inputs?.at(-1)?.intent.order.admissionSeq ?? 0) + 1,
      },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: Date.now(),
    },
  };
}

async function cloneAndFenceEdit(
  deps: Deps,
  operation: EditOperation,
  root: CodeUiSessionRecord,
): Promise<void> {
  const source = await prepareEditSource(deps, operation, root);
  if (!source) return;
  const result = await deps.agentRuns.cloneContextHistoryBranch({
    sourceThreadId: source.threadId,
    targetThreadId: operation.targetThreadId,
    reference: source.reference,
    boundaries: mappedHistoryBoundaries(source.history),
  });
  const clone: ClonedTarget = {
    threadId: operation.targetThreadId,
    reference: result.reference,
  };
  operation.progress = { phase: "cloned", clone };
  const history = rebindOwnedHistory({
    turns: source.history,
    result,
    threadId: clone.threadId,
    owner: {
      instanceId: root.instance_id,
      projectId: root.project_id,
      taskId: root.id,
    },
  });
  const scope = await deps.beginRestore(
    operation.actor,
    root.id,
    Number(root.scope_generation),
    {
      baseRevision: source.snapshot.revision,
      baseLogEpoch: source.snapshot.logEpoch,
    },
  );
  operation.progress = { phase: "fenced", clone, scope };
  const prepared: PreparedEdit = {
    record: createEditedInput(operation, root, source, scope),
    inputs: source.inputs,
    previousThreadId: source.previousThreadId,
    turnId: source.row.turnId,
    history,
  };
  operation.progress = { phase: "prepared", clone, scope, prepared };
}

function decideEditPublication(
  deps: Deps,
  operation: EditOperation,
  root: CodeUiSessionRecord,
) {
  const progress = operation.progress;
  if (progress.phase === "rejected")
    return {
      state: requireState(root),
      ack: {
        commandId: operation.envelope.commandId,
        status: "rejected" as const,
        reasonCode: progress.reasonCode,
        message: progress.message,
        revisionAtDecision: Number(root.revision),
      },
    };
  if (
    progress.phase !== "prepared" ||
    root.execution_state !== "revoking" ||
    Number(root.scope_generation) !==
      progress.prepared.record.scopeGeneration ||
    Number(root.branch_generation) !== progress.prepared.record.branchGeneration
  )
    throw new CodeUiRepositoryError(
      "revision_conflict",
      "历史编辑的Task代际改变，未发布新分支",
    );
  const { prepared } = progress;
  const state = cutLatestTurn(root, prepared.turnId);
  state.inheritedHistory = prepared.history;
  const snapshot = state.snapshots.find((entry) => entry.sessionId === root.id);
  if (!snapshot) throw new CodeUiRepositoryError("not_found", "根Task快照缺失");
  const host = createCodeUiConversation({
    sessionId: root.id,
    workspacePath: operation.loaded.project.path,
    config: snapshot.config,
    state,
  });
  host.admitInput(prepared.record, deps.inputOwner);
  host.startInput(prepared.record);
  return {
    state: host.exportState(),
    activeRunId: prepared.record.runId,
    threadBinding: {
      previousThreadId: prepared.previousThreadId,
      threadId: operation.targetThreadId,
      expectedGeneration: prepared.record.scopeGeneration,
    },
    ack: {
      commandId: operation.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: host.getSnapshot().revision,
      ...(operation.kind === "editUserQuery"
        ? {
            result: {
              type: "editUserQuery" as const,
              disposition: "rewind" as const,
              sessionId: root.id,
            },
          }
        : {}),
    },
  };
}

async function finishCommittedEdit(
  deps: Deps,
  operation: EditOperation,
  ack: protocol.CommandAck,
): Promise<void> {
  const progress = operation.progress;
  if (ack.status !== "accepted" || progress.phase !== "prepared") return;
  // DB已原子发布thread/state/ready/ACK；后续租约释放或通知失败不能补偿已发布target。
  operation.progress = { ...progress, phase: "published" };
  try {
    await deps.agentRuns.releaseContextBranch({
      targetThreadId: progress.clone.threadId,
      reference: progress.clone.reference,
    });
  } catch (error) {
    throw new CodeUiRepositoryError(
      "command_conflict",
      `历史编辑已发布且执行域就绪，但原生分支租约未确认释放：${error instanceof Error ? error.message : "执行资源处理失败"}`,
    );
  }
  try {
    await deps.refresh(
      operation.loaded.instanceId,
      operation.loaded.project.path,
      operation.loaded.project.projectId,
    );
  } catch (error) {
    console.warn("[code-ui] 历史编辑已发布且执行域就绪，后续通知失败：", error);
  }
}

async function compensateUnpublishedEdit(
  deps: Deps,
  operation: EditOperation,
  ack: protocol.CommandAck,
): Promise<void> {
  const progress = operation.progress;
  if (
    progress.phase === "preparing" ||
    progress.phase === "rejected" ||
    progress.phase === "published"
  )
    return;
  const failures: unknown[] = [];
  // 清理仍按fence、TARGET顺序；每个失败都留事实，但不能阻止下一项真实释放。
  if (ack.status === "failed" && progress.phase !== "cloned") {
    try {
      await deps.finishRestore(progress.scope, operation.actor, false);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await deps.agentRuns.discardContextBranch({
      targetThreadId: progress.clone.threadId,
      reference: progress.clone.reference,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "历史编辑未发布，分支资源尚未全部确认清理。",
    );
}

function createEditResult(
  deps: Deps,
  operation: EditOperation,
  ack: protocol.CommandAck,
) {
  const progress = operation.progress;
  if (ack.status !== "accepted" || progress.phase !== "published")
    return { result: ack };
  const { prepared, clone } = progress;
  return {
    result: ack,
    publish: () =>
      (operation.publication ??= Promise.resolve().then(() =>
        deps.run(
          operation.actor,
          operation.loaded.project,
          operation.loaded.root.id,
          clone.threadId,
          prepared.record,
          prepared.inputs,
        ),
      )),
  };
}

/** 原行内编辑consumer；native上下文复制完成后才切Task分支，展示DTO从不作为模型输入。 */
export function createCodeUiHistoryEdit(deps: Deps) {
  return {
    async decorate(
      actor: LocalActor,
      loaded: Loaded,
      snapshot: protocol.ConversationSnapshot,
    ) {
      for (const row of snapshot.rows.window)
        if (row.actions) {
          if (row.kind === "userInput") delete row.actions.canEdit;
          if (row.kind === "assistantText") delete row.actions.canRetry;
        }
      if (
        loaded.entry.parent_session_id ||
        !deps.agentRuns.canCloneContextHistoryBranches?.()
      )
        return;
      const row = latestEditableInput(loaded.root, snapshot);
      const retry = latestRetryInput(loaded.root, snapshot);
      if (!row && !retry) return;
      if (retry?.row.sourceCommandId && retry.row.clientId) {
        const turn = await createCodeUiOwnedHistory(deps).resolve(
          actor,
          loaded.root,
          retry.row.turnId,
        );
        const canonical = turn?.canonical;
        if (
          canonical?.intent.kind === "sendText" &&
          canonical.intent.modelSelection &&
          validBoundary(retry.row, turn)
        )
          retry.assistant.actions = {
            ...retry.assistant.actions,
            canRetry: true,
          };
      }
      if (!row) return;
      const turn = await createCodeUiOwnedHistory(deps).resolve(
        actor,
        loaded.root,
        row.turnId,
      );
      if (validBoundary(row, turn))
        row.actions = { ...row.actions, canEdit: true };
    },
    async command(
      actor: LocalActor,
      target: WorkspaceTarget,
      envelope: protocol.CommandEnvelope,
    ) {
      const operation = await createOperation(deps, actor, target, envelope);
      const ack = await deps.repository.applyScopeCommand(
        operation.loaded.instanceId,
        envelope,
        deps.fingerprint(envelope),
        (root) => cloneAndFenceEdit(deps, operation, root),
        (root) => decideEditPublication(deps, operation, root),
        (result) => finishCommittedEdit(deps, operation, result),
      );
      await compensateUnpublishedEdit(deps, operation, ack);
      return createEditResult(deps, operation, ack);
    },
  };
}
