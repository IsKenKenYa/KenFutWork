import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { TrustedCodeInput } from "./attachments/input-types.js";
import { createCodeUiConversation } from "./conversation.js";
import type { CodeAdmittedInput } from "./input-intents.js";
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
  "repository" | "agentRuns" | "agentRunMetadata" | "threads"
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

function validBoundary(
  loaded: Loaded,
  row: protocol.ConversationSnapshot["rows"]["window"][number],
  pre: Awaited<
    ReturnType<CodeUiServiceDeps["agentRunMetadata"]["getOwnedTurnBoundaries"]>
  >["pre"],
) {
  if (
    !pre ||
    row.kind !== "userInput" ||
    pre.inputOrigin !== "userInput" ||
    pre.context.status !== "captured" ||
    pre.instanceId !== loaded.instanceId ||
    pre.projectId !== loaded.project.projectId ||
    pre.taskId !== loaded.root.id ||
    pre.runId !== row.turnId ||
    !pre.inputIdentity ||
    pre.inputIdentity.sourceCommandId !== row.sourceCommandId ||
    pre.inputIdentity.clientId !== row.clientId
  )
    return null;
  return pre;
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
  payload: EditPayload;
  targetThreadId: string;
  progress: EditProgress;
  publication?: Promise<void>;
};
type EditSource = {
  row: EditableRow & { sourceCommandId: string };
  snapshot: protocol.ConversationSnapshot;
  threadId: string;
  reference: ContextReference;
  model: ModelPlan;
  inputs: TrustedCodeInput[];
  previousThreadId: string;
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
  return {
    actor,
    loaded,
    envelope,
    payload: protocol.commandPayloadSchemas.editUserQuery.parse(
      envelope.payload,
    ),
    targetThreadId: deps.threads.createThreadId(),
    progress: { phase: "preparing" },
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
  if (payload.workspaceMode === "rewind") {
    rejectOperation(
      operation,
      "guard.capabilityUnavailable",
      "聊天编辑的文件恢复尚未接通，请使用保留当前文件或独立文件恢复。",
    );
    return;
  }
  const row = latestEditableInput(root, snapshot);
  if (
    !row ||
    row.rowId !== payload.target.rowId ||
    row.entityId !== payload.target.entityId
  ) {
    rejectOperation(
      operation,
      "guard.editTargetUnavailable",
      "请在根Task空闲且队列为空时编辑最新真实用户输入。",
    );
    return;
  }
  if (!deps.agentRuns.canCloneContextBranches?.()) {
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
  const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(
    operation.actor,
    { taskId: root.id, runId: row.turnId },
  );
  const pre = validBoundary(operation.loaded, row, pair.pre);
  if (
    !pre ||
    pre.context.status !== "captured" ||
    row.sourceCommandId === undefined
  ) {
    rejectOperation(
      operation,
      "guard.contextUnavailable",
      "原输入的持久上下文边界不可用，未改动聊天或文件。",
    );
    return;
  }
  const attachments = operation.payload.attachments ?? row.attachments ?? [];
  if (!operation.payload.newText.trim() && !attachments.length) {
    rejectOperation(operation, "guard.emptyInput", "编辑内容不能为空。");
    return;
  }
  const [model, inputs, binding] = await Promise.all([
    deps.model(operation.actor, snapshot.config.modelSelection),
    deps.inputs(operation.actor, root.id, attachments),
    deps.threads.resolveOwnedSessionThread(operation.actor, root.id),
  ]);
  return {
    row: { ...row, sourceCommandId: row.sourceCommandId },
    snapshot,
    threadId: pre.threadId,
    reference: pre.context.reference,
    model,
    inputs,
    previousThreadId: binding.threadId,
  };
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
    editOf: {
      rootSourceCommandId:
        source.row.rootSourceCommandId ?? source.row.sourceCommandId,
      sourceRunId: source.row.turnId,
    },
    intent: {
      sourceCommandId: operation.envelope.commandId,
      queueItemId: randomUUID(),
      clientId: operation.envelope.clientId,
      kind: "sendText",
      text: operation.payload.newText,
      attachments: source.inputs.map((input) => input.attachment),
      modelSelection: source.model.selection,
      mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
        mode: source.snapshot.config.mode,
      }).mode,
      planEnabled: source.snapshot.config.planEnabled,
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
  const clone: ClonedTarget = {
    threadId: operation.targetThreadId,
    reference: await deps.agentRuns.cloneContextBranch({
      sourceThreadId: source.threadId,
      targetThreadId: operation.targetThreadId,
      reference: source.reference,
    }),
  };
  operation.progress = { phase: "cloned", clone };
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
      result: {
        type: "editUserQuery" as const,
        disposition: "rewind" as const,
        sessionId: root.id,
      },
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
  // DB已原子发布thread/state/ACK；后续readiness或通知失败不能补偿已发布target。
  operation.progress = { ...progress, phase: "published" };
  try {
    deps.agentRuns.releaseContextBranch({
      targetThreadId: progress.clone.threadId,
      reference: progress.clone.reference,
    });
    await deps.finishRestore(progress.scope, operation.actor, true);
  } catch (error) {
    throw new CodeUiRepositoryError(
      "command_conflict",
      `历史编辑已发布，但新执行上下文尚未确认就绪：${error instanceof Error ? error.message : "执行资源处理失败"}`,
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
        if (row.kind === "userInput" && row.actions) delete row.actions.canEdit;
      if (
        loaded.entry.parent_session_id ||
        !deps.agentRuns.canCloneContextBranches?.()
      )
        return;
      const row = latestEditableInput(loaded.root, snapshot);
      if (!row) return;
      const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(actor, {
        taskId: loaded.root.id,
        runId: row.turnId,
      });
      if (validBoundary(loaded, row, pair.pre))
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
