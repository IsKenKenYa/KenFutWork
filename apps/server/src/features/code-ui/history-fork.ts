import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AgentContextHistoryReference } from "../../agent/context-history.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  type CodeUiCompletedTurnView,
  createCodeUiConversation,
} from "./conversation.js";
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
  "repository" | "agentRuns" | "agentRunMetadata" | "threads" | "localInstance"
> & {
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
};

function selectedTurn(
  root: CodeUiSessionRecord,
  target: protocol.CommandPayloadMap["forkAssistant"]["target"],
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
  const view = root.state?.completedTurnViews?.find(
    ([turnId]) => turnId === assistant.turnId,
  )?.[1];
  if (!view) return null;
  const rows = snapshot.rows.window.slice(0, index + 1);
  // 这些私有对象尚未迁移所有权，拒绝发表不可独立读取的副本。
  if (
    rows.some(
      (row) =>
        row.kind === "subagent" ||
        (row.kind === "userInput" && row.attachments?.length),
    )
  )
    return null;
  return { snapshot, assistant, view, rows };
}

async function ownedPost(
  deps: Deps,
  actor: LocalActor,
  loaded: Loaded,
  selected: Selection,
) {
  const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(actor, {
    taskId: loaded.root.id,
    runId: selected.assistant.turnId,
  });
  const post = pair.post;
  if (
    post?.context.status !== "captured" ||
    !post.context.reference ||
    post.instanceId !== loaded.instanceId ||
    post.projectId !== loaded.project.projectId ||
    post.taskId !== loaded.root.id ||
    post.runId !== selected.assistant.turnId
  )
    return null;
  return { threadId: post.threadId, reference: post.context.reference };
}

function forkState(id: string, path: string, source: Selection) {
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
  const rows = structuredClone(source.rows);
  for (const row of rows) if ("actions" in row) delete row.actions;
  child.rows = {
    window: rows,
    totalCount: source.rows.length,
    firstRowId: source.rows[0]?.rowId ?? null,
  };
  child.plan = structuredClone(source.view.plan);
  // 新Task没有执行过父Task的Run；历史保留上下文占用，不重复计入父消费。
  child.usage.contextWindow = structuredClone(source.view.usage.contextWindow);
  child.meta = structuredClone(source.snapshot.meta);
  return state;
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
  child?: CodeUiRootInsert;
  source?: {
    scopeGeneration: number;
    branchGeneration: number;
    logEpoch: string;
  };
  decision?: protocol.CommandAck;
  published: boolean;
  publicationUncertain?: boolean;
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
  const selected = selectedTurn(root, operation.target);
  if (
    !selected ||
    !deps.agentRuns.canCloneContextBranches?.() ||
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
  operation.clone = {
    targetThreadId: threadId,
    reference: await deps.agentRuns.cloneContextBranch({
      sourceThreadId: post.threadId,
      targetThreadId: threadId,
      reference: post.reference,
    }),
  };
  operation.source = {
    scopeGeneration: Number(root.scope_generation),
    branchGeneration: Number(root.branch_generation),
    logEpoch: selected.snapshot.logEpoch,
  };
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
    state: forkState(id, root.root_directory, selected),
  };
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
  deps.agentRuns.releaseContextBranch(operation.clone);
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
    async decorate(actor: LocalActor, loaded: Loaded, snapshot: Snapshot) {
      const available =
        !loaded.entry.parent_session_id &&
        deps.agentRuns.canCloneContextBranches?.();
      snapshot.availability.fork = available
        ? { allowed: true }
        : { allowed: false, reasonCode: "guard.capabilityUnavailable" };
      for (const row of snapshot.rows.window) {
        if (row.kind !== "assistantText") continue;
        const selected =
          available && row.entityId
            ? selectedTurn(loaded.root, {
                rowId: row.rowId,
                entityId: row.entityId,
              })
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
          if (
            operation?.clone &&
            !operation.published &&
            !operation.publicationUncertain
          )
            await deps.agentRuns.discardContextBranch(operation.clone);
        } finally {
          releaseAdmission();
        }
      }
    },
  };
}
