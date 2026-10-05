import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  collectTurnFileChanges,
  requireFileChangesTarget,
} from "./file-changes.js";
import {
  applyFileRewind,
  type PreparedFileRewind,
  prepareFileRewind,
} from "./file-rewind.js";
import { CodeUiRepositoryError } from "./repository.js";
import type { CodeUiService, CodeUiServiceDeps } from "./service.js";

const requestSchema = protocol.v4ConversationFileChangesParamsSchema
  .extend({
    workspacePath: z.string().min(1),
    projectId: z.uuid().optional(),
    workspaceIdentity: z.string().min(1).optional(),
  })
  .passthrough();
type WorkspaceTarget = {
  workspacePath: string;
  projectId?: string | undefined;
  workspaceIdentity?: string | undefined;
};
type Request = protocol.V4ConversationFileChangesParams & WorkspaceTarget;
type Loaded = Awaited<ReturnType<CodeUiService["loadConversation"]>>;
type Guard = Pick<
  protocol.V4ConversationFileChangesParams,
  "baseRevision" | "baseLogEpoch"
>;
type Deps = Pick<
  CodeUiServiceDeps,
  | "repository"
  | "executionScopes"
  | "agentRunMetadata"
  | "settings"
  | "checkpoints"
  | "processSandbox"
> & {
  load(actor: LocalActor, sessionId: string): Promise<Loaded>;
  beginRestore(
    scope: ExecutionScopeHandle,
    actor: LocalActor,
    guard: Guard,
  ): Promise<ExecutionScopeHandle>;
  finishRestore(
    scope: ExecutionScopeHandle,
    actor: LocalActor,
    success: boolean,
  ): Promise<void>;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
  fingerprint(envelope: protocol.CommandEnvelope): string;
};

function parseRequest(value: Request): Request {
  return requestSchema.parse(value);
}
function assertTarget(loaded: Loaded, request: Request) {
  if (
    request.workspacePath !== loaded.project.path ||
    (request.projectId && request.projectId !== loaded.project.projectId) ||
    (request.workspaceIdentity &&
      request.workspaceIdentity !==
        JSON.stringify([loaded.project.projectId, loaded.project.path]))
  )
    throw new CodeUiRepositoryError(
      "not_found",
      "文件变更不属于该Project与Task固定目录。",
    );
}
function capturedPair(
  loaded: Loaded,
  runId: string,
  pair: Awaited<
    ReturnType<CodeUiServiceDeps["agentRunMetadata"]["getOwnedTurnBoundaries"]>
  >,
) {
  const { pre, post } = pair;
  if (
    !pre ||
    !post ||
    pre.phase !== "pre" ||
    post.phase !== "post" ||
    pre.threadId !== post.threadId ||
    pre.files.status !== "captured" ||
    post.files.status !== "captured" ||
    [pre, post].some(
      (boundary) =>
        boundary.runId !== runId ||
        boundary.taskId !== loaded.root.id ||
        boundary.instanceId !== loaded.instanceId ||
        boundary.projectId !== loaded.project.projectId ||
        boundary.scopeGeneration !== Number(loaded.root.scope_generation) ||
        boundary.branchGeneration !== Number(loaded.root.branch_generation),
    )
  )
    return null;
  return [
    {
      runId: pre.runId,
      preCheckpointId: pre.files.reference,
      postCheckpointId: post.files.reference,
    },
  ];
}

/** 原V4文件控制的唯一consumer；公开preview永不带私有恢复字节或context引用。 */
export function createCodeUiFileHistory(deps: Deps) {
  const load = async (actor: LocalActor, request: Request) => {
    const loaded = await deps.load(actor, request.sessionId);
    assertTarget(loaded, request);
    return loaded;
  };
  const prepare = async (
    actor: LocalActor,
    request: Request,
    loaded: Loaded,
  ) => {
    if (!deps.checkpoints || !deps.processSandbox)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "文件恢复能力尚未装配。",
      );
    if (
      loaded.entry.parent_session_id ||
      loaded.root.archived ||
      loaded.root.execution_state !== "ready" ||
      loaded.root.active_run_id
    )
      throw new CodeUiRepositoryError(
        "command_conflict",
        "请在可执行根Task空闲时恢复文件。",
      );
    const snapshot = loaded.host.getSnapshot(request.sessionId);
    const header = requireFileChangesTarget(snapshot, request);
    const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(actor, {
      taskId: loaded.root.id,
      runId: header.turnId,
    });
    const limits = await deps.settings.getInstanceSettings(
      actor,
      loaded.instanceId,
    );
    const events = await deps.repository.readToolCompletions(
      loaded.instanceId,
      loaded.root.id,
      header.turnId,
      {
        maxEvents: limits.codeSearchMaxResults,
        maxBytes: limits.codePatchMaxBytes,
      },
    );
    const calls = new Set(
      snapshot.rows.window
        .filter(
          (row) => row.kind === "toolCall" && row.turnId === header.turnId,
        )
        .map((row) => (row.kind === "toolCall" ? row.toolCallId : "")),
    );
    const scope = await deps.executionScopes.openTask(actor, loaded.root.id);
    const plan = await prepareFileRewind({
      scope,
      actor,
      snapshot,
      params: request,
      events: events.filter((event) =>
        calls.has(`${event.runId}/${event.toolCallId}`),
      ),
      captures: capturedPair(loaded, header.turnId, pair),
      checkpoints: deps.checkpoints,
    });
    return { plan, scope };
  };
  const markReverted = async (
    request: Request,
    loaded: Loaded,
    envelope: protocol.CommandEnvelope,
    scope: ExecutionScopeHandle,
  ) => {
    await deps.repository.appendEvent(
      loaded.instanceId,
      loaded.root.id,
      {
        key: `file-rewind:${envelope.clientId}/${envelope.commandId}`,
        fingerprint: JSON.stringify([
          request.target,
          scope.describe().generation,
        ]),
        event: {
          type: "files.reverted",
          target: request.target,
          generation: scope.describe().generation,
        },
      },
      (root) => {
        const state = structuredClone(root.state!);
        const snapshot = state.snapshots.find(
          (entry) => entry.sessionId === request.sessionId,
        )!;
        const header = snapshot.rows.window.find(
          (row) =>
            row.rowId === request.target.rowId &&
            row.entityId === request.target.entityId,
        );
        if (
          root.execution_state !== "revoking" ||
          Number(root.scope_generation) !== scope.describe().generation ||
          header?.kind !== "turnHeader"
        )
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "Task在文件恢复提交期间改变。",
          );
        const { items: _items, ...summary } = collectTurnFileChanges(
          snapshot,
          header.turnId,
        );
        header.fileChanges = { ...summary, state: "reverted" };
        if (header.actions) delete header.actions.canRewindFiles;
        snapshot.seq += 1;
        snapshot.revision += 1;
        return { state, activeRunId: null };
      },
    );
    try {
      await deps.refresh(
        loaded.instanceId,
        loaded.project.path,
        loaded.project.projectId,
      );
    } catch (error) {
      console.warn("[code-ui] 文件恢复事实已保存，订阅刷新失败：", error);
    }
  };
  return {
    async preview(actor: LocalActor, value: Request) {
      const request = parseRequest(value);
      const loaded = await load(actor, request);
      const prepared = await prepare(actor, request, loaded);
      return {
        result: protocol.v4ConversationFileRewindPreviewResultSchema.parse(
          prepared.plan.preview,
        ),
      };
    },
    async command(
      actor: LocalActor,
      value: WorkspaceTarget,
      envelope: protocol.CommandEnvelope,
    ) {
      const { target } = protocol.commandPayloadSchemas.applyFileRewind.parse(
        envelope.payload,
      );
      const request = parseRequest({
        ...value,
        sessionId: envelope.sessionId!,
        target,
        baseRevision: envelope.baseRevision!,
        baseLogEpoch: envelope.baseLogEpoch!,
      });
      // 幂等回执先于CAS检查；重放不能因原操作已推进revision而再次执行文件effect。
      const loaded = await load(actor, request);
      let plan: PreparedFileRewind | undefined;
      let restored: ExecutionScopeHandle | undefined;
      const ack = await deps.repository.applyScopeCommand(
        loaded.instanceId,
        envelope,
        deps.fingerprint(envelope),
        async () => {
          const current = await load(actor, request);
          const prepared = await prepare(actor, request, current);
          plan = prepared.plan;
          if (!plan.preview.canApply) return;
          await applyFileRewind(plan, {
            scope: prepared.scope,
            actor,
            processSandbox: deps.processSandbox!,
            beginRestore: (scope, owner) =>
              deps.beginRestore(scope, owner, request),
            finishRestore: async (scope, owner, success) => {
              if (!success) return deps.finishRestore(scope, owner, false);
              restored = scope;
              try {
                await markReverted(request, current, envelope, scope);
              } catch (error) {
                throw new Error(
                  `文件已完成恢复，Task暂未重新开放；保存恢复事实失败：${error instanceof Error ? error.message : "持久化不可用"}`,
                );
              }
            },
          });
        },
        (root) => ({
          state: root.state!,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: root.state!.snapshots.find(
              (entry) => entry.sessionId === request.sessionId,
            )!.revision,
            result: {
              type: "applyFileRewind",
              applied: !!restored,
              preview: plan!.preview,
              response: restored
                ? "已撤销所选轮次的文件变更，聊天历史已保留。"
                : "文件不满足安全恢复条件，请查看预览原因。",
            },
          },
        }),
        async () => {
          if (restored) await deps.finishRestore(restored, actor, true);
        },
      );
      if (ack.status === "failed" && restored)
        await deps.finishRestore(restored, actor, false);
      return { result: ack };
    },
    async refreshAvailability(
      actor: LocalActor,
      sessionId: string,
      runId: string,
    ) {
      if (
        !deps.checkpoints ||
        !deps.processSandbox ||
        typeof deps.agentRunMetadata?.getOwnedTurnBoundaries !== "function"
      )
        return;
      const loaded = await deps.load(actor, sessionId);
      const snapshot = loaded.host.getSnapshot(sessionId);
      const header = snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.turnId === runId,
      );
      if (
        loaded.entry.parent_session_id ||
        header?.kind !== "turnHeader" ||
        header.state === "running" ||
        !header.fileChanges?.files ||
        header.fileChanges.state === "reverted" ||
        header.actions?.canRewindFiles
      )
        return;
      const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(actor, {
        taskId: loaded.root.id,
        runId,
      });
      if (!capturedPair(loaded, runId, pair)) return;
      await deps.repository.appendEvent(
        loaded.instanceId,
        loaded.root.id,
        {
          key: `file-rewind-available:${runId}`,
          fingerprint: JSON.stringify([
            runId,
            Number(loaded.root.scope_generation),
            Number(loaded.root.branch_generation),
          ]),
          event: { type: "files.rewindAvailable", runId },
        },
        (root) => {
          const state = structuredClone(root.state!);
          const current = state.snapshots.find(
            (entry) => entry.sessionId === sessionId,
          )!;
          const row = current.rows.window.find(
            (entry) => entry.kind === "turnHeader" && entry.turnId === runId,
          );
          if (
            Number(root.scope_generation) ===
              Number(loaded.root.scope_generation) &&
            Number(root.branch_generation) ===
              Number(loaded.root.branch_generation) &&
            row?.kind === "turnHeader" &&
            row.state !== "running" &&
            row.fileChanges?.state !== "reverted"
          ) {
            row.actions = { ...row.actions, canRewindFiles: true };
            current.seq += 1;
            current.revision += 1;
          }
          return { state, activeRunId: root.active_run_id };
        },
      );
      await deps.refresh(
        loaded.instanceId,
        loaded.project.path,
        loaded.project.projectId,
      );
    },
  };
}
