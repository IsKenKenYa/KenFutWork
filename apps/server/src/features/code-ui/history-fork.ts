import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AgentContextHistoryReference } from "../../agent/context-history.js";
import type { LocalActor } from "../local-instance/types.js";
import type {
  CodeAttachmentHistoryCopy,
  CodeAttachmentsService,
} from "./attachments/types.js";
import {
  childFileChanges,
  childIdentityMap,
  freezeChildSnapshots,
  remapChildSnapshot,
  remapHistoryRows,
} from "./child-history.js";
import {
  type CodeUiCompletedTurnView,
  createCodeUiConversation,
} from "./conversation.js";
import type { HistoryPreparationOwner } from "./history-preparation.js";
import type {
  CodeUiOutputCopy,
  CodeUiOutputHistory,
} from "./output-history-types.js";
import {
  captureHistoryFileChanges,
  createCodeUiOwnedHistory,
  mappedHistoryBoundaries,
  rebindOwnedHistory,
} from "./owned-history.js";
import type {
  CodeUiInheritedSession,
  CodeUiOwnedHistoryTurn,
} from "./owned-history-types.js";
import {
  CodeUiCommandOutcomeUnknownError,
  CodeUiRepositoryError,
  type CodeUiRootInsert,
  type CodeUiSessionRecord,
} from "./repository.js";
import type { CodeUiService, CodeUiServiceDeps } from "./service.js";

type Loaded = Awaited<ReturnType<CodeUiService["loadConversation"]>>;
type Snapshot = protocol.ConversationSnapshot;
type Target = {
  workspacePath: string;
  projectId?: string;
  workspaceIdentity?: string;
};
type Deps = Pick<
  CodeUiServiceDeps,
  | "repository"
  | "agentRuns"
  | "agentRunMetadata"
  | "threads"
  | "localInstance"
  | "settings"
> & {
  owner: HistoryPreparationOwner;
  blob?: CodeUiServiceDeps["blob"];
  attachments?: () => CodeAttachmentsService | undefined;
  outputs?: () => CodeUiOutputHistory;
  load(actor: LocalActor, sessionId: string): Promise<Loaded>;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
  fingerprint(envelope: protocol.CommandEnvelope): string;
};
type Selection = {
  snapshot: Snapshot;
  assistant: Extract<
    Snapshot["rows"]["window"][number],
    { kind: "assistantText" }
  >;
  view: CodeUiCompletedTurnView;
  rows: Snapshot["rows"]["window"];
  children: Snapshot[];
};

function selectedTurn(
  root: CodeUiSessionRecord,
  target: protocol.CommandPayloadMap["forkAssistant"]["target"],
  canCopyAttachments: boolean,
): Selection | null {
  const snapshot = root.state?.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (
    !snapshot ||
    root.archived ||
    root.execution_state !== "ready" ||
    root.state?.inputs?.some(
      (entry) =>
        entry.runId === root.active_run_id && entry.intent.kind === "compact",
    )
  )
    return null;
  const index = snapshot.rows.window.findIndex(
    (row) => row.rowId === target.rowId && row.entityId === target.entityId,
  );
  const assistant = snapshot.rows.window[index];
  if (assistant?.kind !== "assistantText" || assistant.state !== "complete")
    return null;
  const header = snapshot.rows.window.find(
    (row) => row.kind === "turnHeader" && row.turnId === assistant.turnId,
  );
  if (
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    header.executionKind !== "agent"
  )
    return null;
  if (
    snapshot.rows.window
      .slice(index + 1)
      .some(
        (row) =>
          row.kind === "assistantText" && row.turnId === assistant.turnId,
      )
  )
    return null;
  const view =
    root.state?.completedTurnViews?.find(
      ([turnId]) => turnId === assistant.turnId,
    )?.[1] ??
    root.state?.inheritedHistory?.find(
      (turn) => turn.owner.turnId === assistant.turnId,
    )?.completedView;
  if (!view) return null;
  const frozenRows = view.frozenRows ?? snapshot.rows.window;
  const frozenIndex = frozenRows.findIndex(
    (row) => row.rowId === target.rowId && row.entityId === target.entityId,
  );
  if (frozenIndex < 0) return null;
  const rows = frozenRows.slice(0, frozenIndex + 1);
  const children = freezeChildSnapshots(
    {
      ...snapshot,
      rows: {
        window: rows,
        totalCount: rows.length,
        firstRowId: rows[0]?.rowId ?? null,
      },
    },
    new Map(
      (view.childSnapshots ?? []).map((child) => [child.sessionId, child]),
    ),
  );
  // 这些私有对象尚未迁移所有权，拒绝发表不可独立读取的副本。
  if (
    rows.some(
      (row) =>
        !canCopyAttachments &&
        row.kind === "userInput" &&
        row.attachments?.length,
    )
  )
    return null;
  return { snapshot, assistant, view, rows, children };
}

async function ownedPost(
  deps: Deps,
  actor: LocalActor,
  loaded: Loaded,
  selected: Selection,
) {
  const turn = await createCodeUiOwnedHistory(deps).resolve(
    actor,
    loaded.root,
    selected.assistant.turnId,
  );
  const post = turn?.context.post;
  if (post?.status !== "captured" || !post.reference || !turn) return null;
  return { threadId: turn.context.threadId, reference: post.reference };
}

function forkState(
  id: string,
  path: string,
  source: Selection,
  inherited: CodeUiOwnedHistoryTurn[],
  attachments: ReadonlyMap<string, protocol.AttachmentRef>,
  owner: { instanceId: string; projectId: string },
  files: ReadonlyMap<string, CodeUiInheritedSession["fileChanges"]>,
  resources: {
    identity: ReturnType<typeof childIdentityMap>;
    outputs?: CodeUiOutputCopy;
  },
) {
  const config = structuredClone(source.view.config);
  delete config.permissionGrant;
  delete config.planTransition;
  const state = createCodeUiConversation({
    sessionId: id,
    workspacePath: path,
    config,
  }).exportState();
  const child = state.snapshots[0];
  if (!child) throw new Error("分叉Task初始化未生成根快照。");
  const identity = {
    ...resources.identity,
    resourceBindings: resources.outputs?.bindings ?? [],
    attachments: (refs: readonly protocol.AttachmentRef[]) =>
      mappedAttachments(refs, attachments),
  };
  const rows = remapHistoryRows(
    source.rows,
    id,
    source.snapshot.sessionId,
    identity,
  );
  const copiedChildren = source.children.map((original) =>
    remapChildSnapshot(original, identity),
  );
  for (const turn of inherited) {
    const view = turn.completedView;
    if (view?.frozenRows)
      view.frozenRows = remapHistoryRows(
        view.frozenRows,
        id,
        source.snapshot.sessionId,
        identity,
      );
    if (view?.childSnapshots)
      view.childSnapshots = view.childSnapshots.map((child) =>
        remapChildSnapshot(child, identity),
      );
  }
  const closedById = new Map(
    copiedChildren.map((snapshot) => [snapshot.sessionId, snapshot]),
  );
  for (const currentRows of [
    rows,
    ...copiedChildren.map((snapshot) => snapshot.rows.window),
  ])
    for (const row of currentRows)
      if (
        row.kind === "subagent" &&
        row.status === "running" &&
        row.childSessionId &&
        closedById.has(row.childSessionId)
      ) {
        row.status = "cancelled";
        row.summaryText = "分叉截点历史副本不继承执行；源子代理未被停止。";
      }
  child.rows = {
    window: rows,
    totalCount: source.rows.length,
    firstRowId: rows[0]?.rowId ?? null,
  };
  child.seq = rows.length;
  state.inheritedHistory = inherited;
  state.inheritedOutputs = structuredClone(resources.outputs?.records ?? []);
  state.snapshots.push(...copiedChildren);
  state.inheritedSessions = source.children.map((original) => ({
    owner: {
      instanceId: owner.instanceId,
      projectId: owner.projectId,
      taskId: id,
      sessionId: identity.sessions.get(original.sessionId) ?? "",
    },
    source: {
      taskId: source.snapshot.sessionId,
      sessionId: original.sessionId,
    },
    fileChanges: (files.get(original.sessionId) ?? []).map((file) => ({
      turnId: identity.turns.get(file.turnId) ?? file.turnId,
      details: structuredClone(file.details),
    })),
  }));
  if (child.subagents)
    child.subagents = {
      revision: 0,
      childSessionIds: rows.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId
          ? [row.childSessionId]
          : [],
      ),
      running: [],
      endedTotal: rows.filter((row) => row.kind === "subagent").length,
    };
  child.plan = structuredClone(source.view.plan);
  // 新Task没有执行过父Task的Run；历史保留上下文占用，不重复计入父消费。
  child.usage.contextWindow = structuredClone(source.view.usage.contextWindow);
  child.meta = structuredClone(source.snapshot.meta);
  return state;
}

function mappedAttachments(
  refs: readonly protocol.AttachmentRef[],
  mapping: ReadonlyMap<string, protocol.AttachmentRef>,
) {
  return refs.map((attachment) => {
    const mapped = mapping.get(attachment.ref);
    if (!mapped)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "附件历史映射不完整，未发表新Task。",
      );
    return structuredClone(mapped);
  });
}

function assertTarget(loaded: Loaded, target: Target) {
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
      "分叉目标不属于该Project与根Task固定目录。",
    );
}

function forkAck(
  envelope: protocol.CommandEnvelope,
  root: CodeUiSessionRecord,
  child?: CodeUiRootInsert,
): protocol.CommandAck {
  return child
    ? {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision:
          root.state?.snapshots.find((entry) => entry.sessionId === root.id)
            ?.revision ?? 0,
        result: { type: "forkAssistant", sessionId: child.sessionId },
      }
    : {
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision:
          root.state?.snapshots.find((entry) => entry.sessionId === root.id)
            ?.revision ?? 0,
        reasonCode: "guard.forkTargetUnavailable",
        message:
          "该回复缺少可独立分叉的成功边界，或包含尚未迁移的私有附件/子会话。",
      };
}

type ForkOperation = {
  actor: LocalActor;
  loaded: Loaded;
  envelope: protocol.CommandEnvelope;
  target: protocol.CommandPayloadMap["forkAssistant"]["target"];
  clone?: {
    targetThreadId: string;
    reference: AgentContextHistoryReference | null;
  };
  attachments?: CodeAttachmentHistoryCopy;
  outputs?: CodeUiOutputCopy;
  child?: CodeUiRootInsert;
  source?: {
    scopeGeneration: number;
    branchGeneration: number;
    logEpoch: string;
  };
  decision?: protocol.CommandAck;
  published: boolean;
  publicationUncertain?: boolean;
  preparationId?: string;
};

function checkForkGuard(operation: ForkOperation, root: CodeUiSessionRecord) {
  const snapshot = root.state?.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (!snapshot)
    throw new CodeUiRepositoryError("not_found", "分叉根Task快照不存在。");
  const envelope = operation.envelope;
  const reason =
    envelope.baseRevision === undefined
      ? "proto.missingBaseRevision"
      : snapshot.logEpoch !== envelope.baseLogEpoch
        ? "proto.staleLogEpoch"
        : snapshot.revision !== envelope.baseRevision
          ? "proto.staleRevision"
          : null;
  if (!reason) return false;
  operation.decision = {
    commandId: envelope.commandId,
    status: reason === "proto.missingBaseRevision" ? "rejected" : "stale",
    reasonCode: reason,
    revisionAtDecision: snapshot.revision,
  };
  return true;
}

async function prepareFork(
  deps: Deps,
  operation: ForkOperation,
  root: CodeUiSessionRecord,
) {
  if (checkForkGuard(operation, root)) return;
  const attachmentService = deps.attachments?.();
  const selected = selectedTurn(root, operation.target, !!attachmentService);
  if (
    !selected ||
    !deps.agentRuns.canCloneContextHistoryBranches?.() ||
    !root.root_directory
  )
    return;
  const post = await ownedPost(
    deps,
    operation.actor,
    operation.loaded,
    selected,
  );
  if (!post) return;
  const id = randomUUID();
  const threadId = deps.threads.createThreadId();
  operation.preparationId = await deps.repository.preparations.begin({
    instanceId: root.instance_id,
    projectId: root.project_id,
    sourceTaskId: root.id,
    targetTaskId: id,
    targetThreadId: threadId,
    clientId: operation.envelope.clientId,
    commandId: operation.envelope.commandId,
    ...deps.owner,
  });
  const preparationId = operation.preparationId;
  const { turns, turnIds, childFiles } = await collectForkHistory(
    deps,
    operation,
    root,
    selected,
  );
  await prepareForkAttachments(
    attachmentService,
    operation,
    root,
    id,
    selected,
    turns,
    (path) =>
      deps.repository.preparations.planObject(root.instance_id, preparationId, {
        bucket: "code-attachments",
        path,
      }),
  );
  const identity = childIdentityMap(id, selected.children, new Map(turnIds));
  const outputService = deps.outputs?.();
  if (outputService)
    operation.outputs = await outputService.prepare(
      operation.actor,
      root,
      {
        instanceId: root.instance_id,
        projectId: root.project_id,
        taskId: id,
        childSessionIds: identity.sessions,
      },
      [
        ...selected.rows,
        ...selected.children.flatMap((child) => child.rows.window),
      ],
      (path) =>
        deps.repository.preparations.planObject(
          root.instance_id,
          preparationId,
          { bucket: "task-output-history", path },
        ),
    );
  const mapped = await deps.agentRuns.cloneContextHistoryBranch({
    sourceThreadId: post.threadId,
    targetThreadId: threadId,
    reference: post.reference,
    boundaries: mappedHistoryBoundaries(turns),
    resourceBindings: operation.outputs?.bindings ?? [],
  });
  operation.clone = { targetThreadId: threadId, reference: mapped.reference };
  operation.source = {
    scopeGeneration: Number(root.scope_generation),
    branchGeneration: Number(root.branch_generation),
    logEpoch: selected.snapshot.logEpoch,
  };
  const inherited = rebindOwnedHistory({
    turns,
    result: mapped,
    threadId,
    owner: {
      instanceId: operation.loaded.instanceId,
      projectId: root.project_id,
      taskId: id,
    },
    turnIds,
  });
  const attachments =
    operation.attachments?.attachments ??
    new Map<string, protocol.AttachmentRef>();
  for (const turn of inherited)
    if (turn.canonical)
      turn.canonical.intent.attachments = mappedAttachments(
        turn.canonical.intent.attachments,
        attachments,
      );
  const attachmentCopy = operation.attachments;
  operation.child = {
    sessionId: id,
    projectId: root.project_id,
    createdByClientId: operation.actor.accessClientId,
    threadId,
    scope: {
      instanceId: operation.loaded.instanceId,
      projectId: root.project_id,
      taskId: id,
      generation: 0,
      rootDirectory: root.root_directory,
      additionalDirectories: structuredClone(root.additional_directories ?? []),
      sandboxMode: root.sandbox_mode,
    },
    state: forkState(
      id,
      root.root_directory,
      selected,
      inherited,
      attachments,
      { instanceId: root.instance_id, projectId: root.project_id },
      childFiles,
      {
        identity,
        ...(operation.outputs ? { outputs: operation.outputs } : {}),
      },
    ),
    ...(attachmentCopy
      ? { publishArtifacts: (scoped) => attachmentCopy.publish(scoped) }
      : {}),
  };
}

async function discardUnpublishedFork(
  deps: Deps,
  operation: ForkOperation | undefined,
) {
  if (!operation || operation.published || operation.publicationUncertain)
    return;
  const failures: unknown[] = [];
  for (const resource of [operation.attachments, operation.outputs])
    try {
      await resource?.discard();
    } catch (error) {
      failures.push(error);
    }
  if (operation.clone)
    try {
      await deps.agentRuns.discardContextBranch(operation.clone);
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(failures, "未发表分叉的私有资源未全部确认清理。");
  if (operation.preparationId)
    await deps.repository.preparations.remove(
      operation.loaded.instanceId,
      operation.preparationId,
    );
}

function decideFork(operation: ForkOperation, root: CodeUiSessionRecord) {
  const { child, source } = operation;
  const current = root.state?.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (
    child &&
    (!source ||
      Number(root.scope_generation) !== source.scopeGeneration ||
      Number(root.branch_generation) !== source.branchGeneration ||
      current?.logEpoch !== source.logEpoch ||
      root.archived ||
      root.execution_state !== "ready")
  )
    throw new CodeUiRepositoryError(
      "revision_conflict",
      "分叉发布前Task授权或分支改变，未发布新Task。",
    );
  return {
    state: null,
    ...(child ? { newRoot: child } : {}),
    ack: operation.decision ?? forkAck(operation.envelope, root, child),
  };
}

async function finishFork(
  deps: Deps,
  operation: ForkOperation,
  ack: protocol.CommandAck,
) {
  if (ack.status !== "accepted" || !operation.clone || !operation.child) return;
  // child/state/ACK已原子发表，之后的通知或租约释放不能删掉已可使用的native分支。
  operation.published = true;
  operation.attachments?.release();
  operation.outputs?.release();
  await deps.agentRuns.releaseContextBranch(operation.clone);
  if (operation.preparationId)
    await deps.repository.preparations.remove(
      operation.loaded.instanceId,
      operation.preparationId,
    );
  try {
    await deps.refresh(
      operation.loaded.instanceId,
      operation.loaded.project.path,
      operation.loaded.project.projectId,
    );
  } catch (error) {
    console.warn("[code-ui] 分叉已持久化，后续通知失败：", error);
  }
}

/** 会话分叉只准备新的native thread与Task，不恢复文件、不撤销父执行资源。 */
export function createCodeUiHistoryFork(deps: Deps) {
  return {
    async recover() {
      await deps.repository.preparations.recover(
        deps.owner,
        deps.agentRuns,
        deps.blob,
      );
    },
    async decorate(actor: LocalActor, loaded: Loaded, snapshot: Snapshot) {
      const available =
        !loaded.entry.parent_session_id &&
        deps.agentRuns.canCloneContextHistoryBranches?.();
      snapshot.availability.fork = available
        ? { allowed: true }
        : { allowed: false, reasonCode: "guard.capabilityUnavailable" };
      for (const row of snapshot.rows.window) {
        if (row.kind !== "assistantText") continue;
        const selected =
          available && row.entityId
            ? selectedTurn(
                loaded.root,
                {
                  rowId: row.rowId,
                  entityId: row.entityId,
                },
                !!deps.attachments?.(),
              )
            : null;
        if (selected && (await ownedPost(deps, actor, loaded, selected)))
          row.actions = { ...row.actions, canFork: true };
        else if (row.actions) delete row.actions.canFork;
      }
    },
    async command(
      actor: LocalActor,
      target: Target,
      envelope: protocol.CommandEnvelope,
    ) {
      const releaseAdmission = deps.localInstance.beginAdmission();
      let operation: ForkOperation | undefined;
      try {
        if (!envelope.sessionId)
          throw new CodeUiRepositoryError("not_found", "分叉缺少根Task身份。");
        const loaded = await deps.load(actor, envelope.sessionId);
        assertTarget(loaded, target);
        const payload = protocol.commandPayloadSchemas.forkAssistant.parse(
          envelope.payload,
        );
        operation = {
          actor,
          loaded,
          envelope,
          target: payload.target,
          published: false,
        };
        const current = operation;
        const ack = await deps.repository.applyScopeCommand(
          loaded.instanceId,
          envelope,
          deps.fingerprint(envelope),
          (root) => prepareFork(deps, current, root),
          (root) => decideFork(current, root),
          (result) => finishFork(deps, current, result),
          "fork_failed",
        );
        return { result: ack };
      } catch (error) {
        if (error instanceof CodeUiCommandOutcomeUnknownError && operation)
          operation.publicationUncertain = true;
        throw error;
      } finally {
        try {
          await discardUnpublishedFork(deps, operation);
        } finally {
          releaseAdmission();
        }
      }
    },
  };
}

async function collectForkHistory(
  deps: Deps,
  operation: ForkOperation,
  root: CodeUiSessionRecord,
  selected: Selection,
) {
  const resolver = createCodeUiOwnedHistory(deps);
  const turns: CodeUiOwnedHistoryTurn[] = [];
  const turnIds = new Map<string, string>();
  // 维护Run只有marker，没有turnHeader；同样必须持有独立历史身份。
  for (const turnId of new Set(selected.rows.map((row) => row.turnId))) {
    const turn = await resolver.resolve(operation.actor, root, turnId);
    if (!turn)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "源前缀缺少可信历史归属，未创建分叉。",
      );
    turns.push(turn);
    turnIds.set(turnId, randomUUID());
  }
  await captureHistoryFileChanges(
    deps,
    operation.actor,
    root,
    selected.snapshot,
    turns,
  );
  const childFiles = new Map<string, CodeUiInheritedSession["fileChanges"]>();
  for (const snapshot of selected.children)
    childFiles.set(
      snapshot.sessionId,
      await childFileChanges(deps, operation.actor, root, snapshot),
    );
  return { turns, turnIds, childFiles };
}

async function prepareForkAttachments(
  service: CodeAttachmentsService | undefined,
  operation: ForkOperation,
  root: CodeUiSessionRecord,
  id: string,
  selected: Selection,
  turns: CodeUiOwnedHistoryTurn[],
  planObject: (path: string) => Promise<void>,
) {
  const refs = [
    ...selected.rows.flatMap((row) =>
      row.kind === "userInput" ? (row.attachments ?? []) : [],
    ),
    ...turns.flatMap((turn) => turn.canonical?.intent.attachments ?? []),
  ];
  if (refs.length) {
    if (!service)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "私有附件历史提供方不可用。",
      );
    operation.attachments = await service.prepareHistory(
      operation.actor,
      root.id,
      {
        instanceId: root.instance_id,
        projectId: root.project_id,
        taskId: id,
        sessionId: id,
        createdByClientId: operation.actor.accessClientId,
        scopeGeneration: 0,
        branchGeneration: 1,
        revision: 0,
        canUpload: true,
      },
      refs,
      planObject,
    );
  }
}
