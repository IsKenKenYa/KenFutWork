import {
  type AdditionalDirectory,
  type CodeExecutionScope,
  zcodeUiProtocol as protocol,
  type SandboxMode,
  type StreamEvent,
  streamEventSchema,
} from "@kenfutwork/shared";
import type {
  PersistenceService,
  SqlRow,
  WorkspaceSqlClient,
} from "../persistence/types.js";
import {
  type CodeUiConversationState,
  createCodeUiConversation,
} from "./conversation.js";
import type { CodeInputSettlement } from "./queue-control.js";

export type CodeUiSessionRecord = SqlRow & {
  id: string;
  workspace_id: string;
  project_id: string;
  root_directory: string | null;
  additional_directories: AdditionalDirectory[] | null;
  sandbox_mode: SandboxMode;
  scope_generation: number | string;
  branch_generation: number | string;
  execution_state: "ready" | "revoking" | "failed";
  chat_session_id: string | null;
  root_session_id: string;
  parent_session_id: string | null;
  parent_tool_call_id: string | null;
  state: CodeUiConversationState | null;
  revision: string | number;
  active_run_id: string | null;
  archived: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export class CodeUiRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "revision_conflict" | "command_conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface CodeUiHumanPreferencesWriteOptions {
  referencedProjectIds?: readonly string[];
  removeKeys?: readonly string[];
}

async function writeState(
  scoped: WorkspaceSqlClient,
  root: CodeUiSessionRecord,
  state: CodeUiConversationState,
  activeRunId: string | null,
) {
  await scoped.execute(
    `update public.code_ui_sessions set state = $2::jsonb, revision = revision + 1, active_run_id = $3, updated_at = now()
      where workspace_id = :workspace and id = $1 and deleted_at is null`,
    [root.id, JSON.stringify(state), activeRunId],
  );
  for (const snapshot of state.snapshots) {
    for (const row of snapshot.rows.window) {
      if (
        row.kind !== "subagent" ||
        !row.childSessionId ||
        !row.parentToolCallId
      )
        continue;
      await scoped.execute(
        `insert into public.code_ui_sessions (id, workspace_id, project_id, root_session_id, parent_session_id, parent_tool_call_id, root_directory, additional_directories, sandbox_mode, scope_generation, execution_state, branch_generation)
         values ($1, :workspace, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) on conflict (id) do nothing`,
        [
          row.childSessionId,
          root.project_id,
          root.id,
          snapshot.sessionId,
          row.parentToolCallId,
          root.root_directory,
          JSON.stringify(root.additional_directories),
          root.sandbox_mode,
          root.scope_generation,
          root.execution_state,
          root.branch_generation,
        ],
      );
    }
  }
}

async function lockRoot(scoped: WorkspaceSqlClient, sessionId: string) {
  const root = await scoped.queryOne<CodeUiSessionRecord>(
    "select * from public.code_ui_sessions where workspace_id = :workspace and id = $1 and parent_session_id is null and deleted_at is null for update",
    [sessionId],
  );
  if (!root?.state)
    throw new CodeUiRepositoryError("not_found", "Code 根会话已删除或不存在");
  return root;
}

async function claimScopeCommand(
  scoped: WorkspaceSqlClient,
  envelope: protocol.CommandEnvelope,
  fingerprint: string,
) {
  await scoped.query(
    "select pg_advisory_xact_lock(hashtextextended(:workspace::text || '/' || $1 || '/' || $2, 0))",
    [envelope.clientId, envelope.commandId],
  );
  const previous = await scoped.queryOne<
    SqlRow & {
      parameter_fingerprint: string | null;
      ack: protocol.CommandAck | null;
      status: string;
    }
  >(
    "select parameter_fingerprint, ack, status from public.code_ui_commands where workspace_id = :workspace and client_id = $1 and command_id = $2",
    [envelope.clientId, envelope.commandId],
  );
  if (previous) {
    if (previous.status === "deleted")
      throw new CodeUiRepositoryError("not_found", "命令所属 Task 已删除");
    if (previous.parameter_fingerprint !== fingerprint)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "同一命令键不能提交不同参数",
      );
    if (!previous.ack)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "授权变更尚未完成，请查询命令状态",
      );
    return {
      ack: protocol.commandAckSchema.parse({
        ...previous.ack,
        status: "duplicate",
      }),
      root: null,
    };
  }
  const root = await lockRoot(scoped, envelope.sessionId!);
  await scoped.execute(
    `insert into public.code_ui_commands (workspace_id, client_id, command_id, session_id, parameter_fingerprint, status)
     values (:workspace, $1, $2, $3, $4, 'pending')`,
    [envelope.clientId, envelope.commandId, root.id, fingerprint],
  );
  return { root, ack: null };
}

async function lockActiveProject(
  scoped: WorkspaceSqlClient,
  root: CodeUiSessionRecord,
) {
  return scoped.queryOne<SqlRow & { id: string }>(
    "select id from public.projects where workspace_id=:workspace and id=$1 and kind='code' and archived_at is null for share",
    [root.project_id],
  );
}

/** 工作区隔离、事务内根会话锁；子会话索引只指向同一权威聚合状态。 */
export function createCodeUiRepository(persistence: PersistenceService) {
  return {
    async recoverRuntimeInputs(owner: {
      hostId: string;
      runtimeId: string;
    }): Promise<void> {
      // 启动恢复跨工作区，但仅匹配该宿主私有owner；调用者先取得TaskWork宿主排他锁。
      const candidates = await persistence.query<CodeUiSessionRecord>(
        `select * from public.code_ui_sessions where parent_session_id is null and deleted_at is null
          and state->'inputOwner'->>'hostId' = $1 and state->'inputOwner'->>'runtimeId' <> $2`,
        [owner.hostId, owner.runtimeId],
      );
      for (const candidate of candidates)
        await persistence.transaction(async (transaction) => {
          const scoped = transaction.forWorkspace(candidate.workspace_id);
          const root = await lockRoot(scoped, candidate.id);
          if (
            root.state!.inputOwner?.hostId !== owner.hostId ||
            root.state!.inputOwner.runtimeId === owner.runtimeId
          )
            return;
          const abandoned =
            root.state!.inputs?.filter((record) =>
              ["active", "queued", "reserved"].includes(record.status),
            ) ?? [];
          const snapshot = root.state!.snapshots.find(
            (entry) => entry.sessionId === root.id,
          )!;
          const host = createCodeUiConversation({
            sessionId: root.id,
            workspacePath: root.root_directory!,
            config: snapshot.config,
            state: root.state!,
          });
          if (root.active_run_id)
            host.recordEvent({
              type: "run.canceled",
              runId: root.active_run_id,
              timestamp: new Date().toISOString(),
            });
          const state = host.exportState();
          const current = state.snapshots.find(
            (entry) => entry.sessionId === root.id,
          )!;
          current.queue = { items: [], autoDrain: false, pauseReason: "error" };
          current.inputRouting = { mode: "startNow" };
          current.pendingCommands = [];
          current.seq += 1;
          current.revision += 1;
          for (const record of state.inputs ?? [])
            if (
              record.status === "queued" ||
              abandoned.some((input) => input.runId === record.runId)
            )
              record.status = "discarded";
          state.inputOwner = { ...owner };
          await writeState(scoped, root, state, null);
          for (const record of abandoned) {
            const ack: protocol.CommandAck = {
              commandId: record.intent.sourceCommandId,
              status: "failed",
              reasonCode: "fault.command.inputDiscardedOnRestart",
              message: "执行宿主已重启，输入未自动重放；请确认后重新提交。",
              revisionAtDecision: current.revision,
              result: {
                type: "inputDisposition",
                delivery: record.intent.delivery.admitted,
              },
            };
            await scoped.execute(
              `update public.code_ui_commands set status = 'failed', ack = $4::jsonb where workspace_id = :workspace and session_id = $1 and client_id = $2 and command_id = $3 and status = 'accepted'`,
              [
                root.id,
                record.intent.clientId,
                record.intent.sourceCommandId,
                JSON.stringify(ack),
              ],
            );
          }
        });
    },
    async readHumanPreferences(
      workspaceId: string,
    ): Promise<Record<string, unknown>> {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ code_ui_preferences: Record<string, unknown> }>(
          "select code_ui_preferences from public.workspace_settings where workspace_id = :workspace",
        );
      return row?.code_ui_preferences ?? {};
    },
    async updateHumanPreferences(
      workspaceId: string,
      patch: Record<string, unknown>,
      options: CodeUiHumanPreferencesWriteOptions = {},
    ): Promise<boolean> {
      const referencedProjectIds = [
        ...new Set(options.referencedProjectIds ?? []),
      ].sort();
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ workspace_id: string }>(
          `with live_projects as (
           select id from public.projects where workspace_id=:workspace and kind='code'
             and archived_at is null and id=any($3::uuid[]) order by id for share
         )
         insert into public.workspace_settings (workspace_id,code_ui_preferences)
         select :workspace,$1::jsonb - $2::text[]
         where (select count(*) from live_projects)=cardinality($3::uuid[])
         on conflict (workspace_id) do update set
           code_ui_preferences=(workspace_settings.code_ui_preferences || excluded.code_ui_preferences) - $2::text[]
         returning workspace_id`,
          [
            JSON.stringify(patch),
            options.removeKeys ?? [],
            referencedProjectIds,
          ],
        );
      return row !== null;
    },
    async beginRewindTask(
      workspaceId: string,
      taskId: string,
      expectedScopeGeneration: number,
      guard?: Pick<
        protocol.V4ConversationFileChangesParams,
        "baseRevision" | "baseLogEpoch"
      >,
    ) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, taskId);
        const snapshot = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        );
        if (
          guard &&
          (snapshot?.revision !== guard.baseRevision ||
            snapshot.logEpoch !== guard.baseLogEpoch)
        )
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "会话在恢复准备期间更新，请重新获取预览。",
          );
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          Number(root.scope_generation) !== expectedScopeGeneration
        )
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "Task 已关闭或工作域改变，请重新获取恢复预览",
          );
        await scoped.execute(
          `update public.code_ui_sessions set execution_state = 'revoking', scope_generation = scope_generation + 1, branch_generation = branch_generation + 1
          where workspace_id = :workspace and root_session_id = $1 and deleted_at is null`,
          [taskId],
        );
        return expectedScopeGeneration + 1;
      });
    },
    async finishRewindTask(
      workspaceId: string,
      taskId: string,
      expectedGeneration: number,
      state: CodeUiConversationState,
      activeRunId: string | null = null,
    ) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, taskId);
        if (
          root.execution_state !== "revoking" ||
          Number(root.scope_generation) !== expectedGeneration
        )
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "Task 代际在恢复准备期间改变",
          );
        await writeState(scoped, root, state, activeRunId);
        await scoped.execute(
          `update public.code_ui_sessions set execution_state = 'ready'
          where workspace_id = :workspace and root_session_id = $1 and execution_state = 'revoking' and scope_generation = $2 and deleted_at is null`,
          [taskId, expectedGeneration],
        );
      });
    },
    async beginCloseTask(workspaceId: string, taskId: string) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, taskId);
        if (root.execution_state === "revoking")
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "Task已经在关闭，请等待本次关闭完成。",
          );
        const changed = await scoped.execute(
          `update public.code_ui_sessions set execution_state = 'revoking',
                scope_generation = scope_generation + 1, branch_generation = branch_generation + 1
          where workspace_id = :workspace and root_session_id = $1 and deleted_at is null`,
          [taskId],
        );
        if (changed === 0)
          throw new CodeUiRepositoryError(
            "not_found",
            "Task 已删除或不属于当前工作区",
          );
        return Number(root.scope_generation) + 1;
      });
    },
    async failCloseTask(
      workspaceId: string,
      taskId: string,
      expectedGeneration?: number,
    ) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_ui_sessions set execution_state = 'failed'
          where workspace_id = :workspace and root_session_id = $1 and execution_state = 'revoking'${expectedGeneration !== undefined ? " and scope_generation = $2" : ""}`,
        [
          taskId,
          ...(expectedGeneration !== undefined ? [expectedGeneration] : []),
        ],
      );
    },
    async advanceBranch(
      workspaceId: string,
      taskId: string,
      expectedBranchGeneration: number,
    ) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SqlRow & { branch_generation: number | string }>(
          `update public.code_ui_sessions set branch_generation = branch_generation + 1
          where workspace_id = :workspace and id = $1 and branch_generation = $2
            and parent_session_id is null and deleted_at is null
          returning branch_generation`,
          [taskId, expectedBranchGeneration],
        );
      if (!row)
        throw new CodeUiRepositoryError(
          "revision_conflict",
          "Task 分支已改变或已删除，拒绝旧分支操作",
        );
      return Number(row.branch_generation);
    },
    async createRoot(
      workspaceId: string,
      input: {
        sessionId: string;
        projectId: string;
        scope: CodeExecutionScope;
        userId: string;
        threadId: string;
        state: CodeUiConversationState;
        command: { clientId: string; commandId: string; fingerprint: string };
      },
    ) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        // 固定散列种子仅为 SQL 锁键算法，非运行时限额。命令键由原客户端生成，重试不变。
        await scoped.query(
          "select pg_advisory_xact_lock(hashtextextended(:workspace::text || '/' || $1 || '/' || $2, 0))",
          [input.command.clientId, input.command.commandId],
        );
        const previous = await scoped.queryOne<
          SqlRow & {
            parameter_fingerprint: string | null;
            ack: protocol.CommandAck | null;
            status: string;
          }
        >(
          "select parameter_fingerprint, ack, status from public.code_ui_commands where workspace_id = :workspace and client_id = $1 and command_id = $2",
          [input.command.clientId, input.command.commandId],
        );
        if (previous) {
          if (previous.status === "deleted")
            throw new CodeUiRepositoryError("not_found", "命令所属会话已删除");
          if (previous.parameter_fingerprint !== input.command.fingerprint)
            throw new CodeUiRepositoryError(
              "command_conflict",
              "同一命令键不能提交不同参数",
            );
          if (previous.ack)
            return protocol.commandAckSchema.parse({
              ...previous.ack,
              status: "duplicate",
            });
          throw new CodeUiRepositoryError("command_conflict", "命令尚未完成");
        }
        const project = await scoped.queryOne<SqlRow & { id: string }>(
          `select id from public.projects
           where workspace_id = :workspace and id = $1 and kind = 'code' and archived_at is null
           for update`,
          [input.projectId],
        );
        if (
          !project ||
          input.scope.workspaceId !== workspaceId ||
          input.scope.projectId !== project.id ||
          input.scope.taskId !== input.sessionId
        ) {
          throw new CodeUiRepositoryError(
            "not_found",
            "Code 项目或 Task 工作域不存在",
          );
        }
        await scoped.execute(
          `insert into public.chat_sessions (id, workspace_id, project_id, mode, created_by, thread_id)
           values ($1::uuid, :workspace, $2::uuid, 'code', $3::uuid, $4::text)`,
          [input.sessionId, input.projectId, input.userId, input.threadId],
        );
        await scoped.execute(
          `insert into public.code_ui_sessions (id, workspace_id, project_id, chat_session_id, root_session_id, state, root_directory, additional_directories, sandbox_mode, scope_generation)
           values ($1, :workspace, $2, $1, $1, $3::jsonb, $4, $5::jsonb, $6, $7)`,
          [
            input.sessionId,
            input.projectId,
            JSON.stringify(input.state),
            input.scope.rootDirectory,
            JSON.stringify(input.scope.additionalDirectories),
            input.scope.sandboxMode,
            input.scope.generation,
          ],
        );
        const ack = protocol.commandAckSchema.parse({
          commandId: input.command.commandId,
          status: "accepted",
          revisionAtDecision: 0,
          result: { type: "createSession", sessionId: input.sessionId },
        });
        await scoped.execute(
          `insert into public.code_ui_commands (workspace_id, client_id, command_id, session_id, parameter_fingerprint, ack, status)
           values (:workspace, $1, $2, $3, $4, $5::jsonb, 'accepted')`,
          [
            input.command.clientId,
            input.command.commandId,
            input.sessionId,
            input.command.fingerprint,
            JSON.stringify(ack),
          ],
        );
        return ack;
      });
    },
    async find(
      workspaceId: string,
      sessionId: string,
    ): Promise<CodeUiSessionRecord | null> {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<CodeUiSessionRecord>(
          "select * from public.code_ui_sessions where workspace_id = :workspace and id = $1 and deleted_at is null",
          [sessionId],
        );
    },
    async list(
      workspaceId: string,
      projectId: string,
    ): Promise<CodeUiSessionRecord[]> {
      return persistence.forWorkspace(workspaceId).query<CodeUiSessionRecord>(
        `select * from public.code_ui_sessions
          where workspace_id = :workspace and project_id = $1 and parent_session_id is null and deleted_at is null
          order by updated_at desc, id`,
        [projectId],
      );
    },
    async listRoots(workspaceId: string): Promise<CodeUiSessionRecord[]> {
      return persistence.forWorkspace(workspaceId).query<CodeUiSessionRecord>(
        `select s.* from public.code_ui_sessions s join public.projects p on p.id = s.project_id
         where s.workspace_id = :workspace and p.workspace_id = :workspace and p.kind = 'code' and p.archived_at is null
           and s.parent_session_id is null order by s.updated_at desc, s.id`,
      );
    },
    async listVersion(workspaceId: string, projectId: string): Promise<number> {
      // 包含删除墓碑，列表序号不会因删除或归档倒退。
      const record = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SqlRow & { seq: string }>(
          "select coalesce(sum(revision + 1), 0)::text as seq from public.code_ui_sessions where workspace_id = :workspace and project_id = $1 and parent_session_id is null",
          [projectId],
        );
      return Number(record?.seq ?? 0);
    },
    async applyCommand(
      workspaceId: string,
      envelope: protocol.CommandEnvelope,
      fingerprint: string,
      decide: (root: CodeUiSessionRecord) => {
        state: CodeUiConversationState | null;
        activeRunId: string | null;
        ack: protocol.CommandAck;
        settlements?: CodeInputSettlement[];
      },
    ) {
      if (!envelope.sessionId)
        throw new CodeUiRepositoryError("not_found", "Code 命令缺少会话身份");
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        await scoped.query(
          "select pg_advisory_xact_lock(hashtextextended(:workspace::text || '/' || $1 || '/' || $2, 0))",
          [envelope.clientId, envelope.commandId],
        );
        const previous = await scoped.queryOne<
          SqlRow & {
            parameter_fingerprint: string | null;
            ack: protocol.CommandAck | null;
            status: string;
          }
        >(
          "select parameter_fingerprint, ack, status from public.code_ui_commands where workspace_id = :workspace and client_id = $1 and command_id = $2",
          [envelope.clientId, envelope.commandId],
        );
        if (previous) {
          if (previous.status === "deleted")
            throw new CodeUiRepositoryError("not_found", "命令所属会话已删除");
          if (previous.parameter_fingerprint !== fingerprint)
            throw new CodeUiRepositoryError(
              "command_conflict",
              "同一命令键不能提交不同参数",
            );
          if (!previous.ack)
            throw new CodeUiRepositoryError("command_conflict", "命令尚未完成");
          return protocol.commandAckSchema.parse({
            ...previous.ack,
            status: "duplicate",
          });
        }
        const root = await lockRoot(scoped, envelope.sessionId!);
        if (!(await lockActiveProject(scoped, root)))
          throw new CodeUiRepositoryError(
            "not_found",
            "Code 项目已归档或不存在",
          );
        const decision = decide(root);
        const ack = protocol.commandAckSchema.parse(decision.ack);
        if (decision.state)
          await writeState(scoped, root, decision.state, decision.activeRunId);
        for (const settlement of decision.settlements ?? [])
          await scoped.execute(
            `update public.code_ui_commands set ack = $4::jsonb, status = 'failed'
            where workspace_id = :workspace and session_id = $1 and client_id = $2 and command_id = $3 and status = 'accepted'`,
            [
              root.id,
              settlement.clientId,
              settlement.commandId,
              JSON.stringify(protocol.commandAckSchema.parse(settlement.ack)),
            ],
          );
        await scoped.execute(
          `insert into public.code_ui_commands (workspace_id, client_id, command_id, session_id, parameter_fingerprint, ack, status)
           values (:workspace, $1, $2, $3, $4, $5::jsonb, 'accepted')`,
          [
            envelope.clientId,
            envelope.commandId,
            root.id,
            fingerprint,
            JSON.stringify(ack),
          ],
        );
        return ack;
      });
    },
    /** 命令先持久认领；撤销在已提交的 revoking 状态下等待，不能把停止等待包进 DB 行锁。 */
    async applyScopeCommand(
      workspaceId: string,
      envelope: protocol.CommandEnvelope,
      fingerprint: string,
      change: (root: CodeUiSessionRecord) => Promise<void>,
      decide: (root: CodeUiSessionRecord) => {
        state: CodeUiConversationState;
        ack: protocol.CommandAck;
        activeRunId?: string | null;
        threadBinding?: {
          previousThreadId: string;
          threadId: string;
          expectedGeneration: number;
        };
      },
      afterCommit?: (ack: protocol.CommandAck) => Promise<void>,
    ): Promise<protocol.CommandAck> {
      if (!envelope.sessionId)
        throw new CodeUiRepositoryError("not_found", "授权命令缺少 Task 身份");
      const claimed = await persistence.transaction((tx) =>
        claimScopeCommand(tx.forWorkspace(workspaceId), envelope, fingerprint),
      );
      if (claimed.ack) return claimed.ack;
      let persisted: protocol.CommandAck;
      try {
        await change(claimed.root!);
        persisted = await persistence.transaction(async (tx) => {
          const scoped = tx.forWorkspace(workspaceId);
          const root = await lockRoot(scoped, envelope.sessionId!);
          const decision = decide(root);
          const ack = protocol.commandAckSchema.parse(decision.ack);
          if (decision.threadBinding) {
            const binding = decision.threadBinding;
            if (
              root.execution_state !== "revoking" ||
              Number(root.scope_generation) !== binding.expectedGeneration ||
              !root.chat_session_id
            )
              throw new CodeUiRepositoryError(
                "revision_conflict",
                "上下文分支发布代际不匹配",
              );
            if (!(await lockActiveProject(scoped, root)))
              throw new CodeUiRepositoryError(
                "not_found",
                "上下文分支的Project已归档",
              );
            const bound = await scoped.execute(
              "update public.chat_sessions set thread_id=$2 where workspace_id=:workspace and id=$1 and project_id=$3 and mode='code' and thread_id=$4",
              [
                root.chat_session_id,
                binding.threadId,
                root.project_id,
                binding.previousThreadId,
              ],
            );
            if (bound !== 1)
              throw new CodeUiRepositoryError(
                "revision_conflict",
                "原Task的上下文绑定已经改变",
              );
          }
          await writeState(
            scoped,
            root,
            decision.state,
            decision.activeRunId === undefined
              ? root.active_run_id
              : decision.activeRunId,
          );
          const written = await scoped.execute(
            `update public.code_ui_commands set ack = $3::jsonb, status = 'accepted'
              where workspace_id = :workspace and client_id = $1 and command_id = $2 and status = 'pending'`,
            [envelope.clientId, envelope.commandId, JSON.stringify(ack)],
          );
          if (written !== 1)
            throw new CodeUiRepositoryError(
              "not_found",
              "授权命令在完成前已删除",
            );
          return ack;
        });
      } catch (error) {
        const ack = protocol.commandAckSchema.parse({
          commandId: envelope.commandId,
          status: "failed",
          reasonCode: "scope_update_failed",
          message: error instanceof Error ? error.message : "Task 授权变更失败",
          revisionAtDecision: Number(claimed.root!.revision),
        });
        await persistence.forWorkspace(workspaceId).execute(
          `update public.code_ui_commands set ack = $3::jsonb, status = 'failed'
            where workspace_id = :workspace and client_id = $1 and command_id = $2 and status = 'pending'`,
          [envelope.clientId, envelope.commandId, JSON.stringify(ack)],
        );
        return ack;
      }
      // 已落库的效果回执不能因readiness/通知失败被改报成未执行；重放也不再次执行effect。
      await afterCommit?.(persisted);
      return persisted;
    },
    async startRunIfCurrent(
      workspaceId: string,
      rootSessionId: string,
      runId: string,
      expected: {
        scopeGeneration: number;
        branchGeneration: number;
        inputRequired: boolean;
      },
      start: (root: CodeUiSessionRecord) => void,
    ): Promise<boolean> {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, rootSessionId);
        const input = root.state?.inputs?.find(
          (entry) => entry.runId === runId,
        );
        if (
          root.archived ||
          root.execution_state !== "ready" ||
          Number(root.scope_generation) !== expected.scopeGeneration ||
          Number(root.branch_generation) !== expected.branchGeneration ||
          root.active_run_id !== runId ||
          root.state?.runId !== runId ||
          root.state.closedRuns.includes(runId) ||
          (expected.inputRequired && !input) ||
          (input &&
            (input.status !== "active" ||
              input.scopeGeneration !== expected.scopeGeneration ||
              input.branchGeneration !== expected.branchGeneration))
        )
          return false;
        const project = await lockActiveProject(scoped, root);
        if (!project) return false;
        // 只登记同步运行句柄，不执行模型 I/O；与 Stop 的同一根锁消除检查/启动窗口。
        start(root);
        return true;
      });
    },
    async appendEvent(
      workspaceId: string,
      rootSessionId: string,
      input: { key: string; fingerprint: string; event: unknown },
      apply: (root: CodeUiSessionRecord) => {
        state: CodeUiConversationState;
        activeRunId: string | null;
        childChat?: {
          sessionId: string;
          threadId: string;
          userId: string;
          title: string;
        };
        settlements?: CodeInputSettlement[];
      },
    ) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, rootSessionId);
        const previous = await scoped.queryOne<
          SqlRow & { parameter_fingerprint: string }
        >(
          "select parameter_fingerprint from public.code_ui_events where workspace_id = :workspace and root_session_id = $1 and event_key = $2",
          [root.id, input.key],
        );
        if (previous) {
          if (previous.parameter_fingerprint !== input.fingerprint)
            throw new CodeUiRepositoryError(
              "command_conflict",
              "同一运行事件身份出现不同参数",
            );
          return false;
        }
        const decision = apply(root);
        await writeState(scoped, root, decision.state, decision.activeRunId);
        for (const settlement of decision.settlements ?? [])
          await scoped.execute(
            `update public.code_ui_commands set ack = $4::jsonb, status = 'failed'
            where workspace_id = :workspace and session_id = $1 and client_id = $2 and command_id = $3 and status = 'accepted'`,
            [
              root.id,
              settlement.clientId,
              settlement.commandId,
              JSON.stringify(protocol.commandAckSchema.parse(settlement.ack)),
            ],
          );
        if (decision.childChat) {
          const child = decision.childChat;
          await scoped.execute(
            `insert into public.chat_sessions (id, workspace_id, project_id, mode, created_by, thread_id, title)
            values ($1, :workspace, $2, 'code', $3, $4, $5) on conflict (id) do nothing`,
            [
              child.sessionId,
              root.project_id,
              child.userId,
              child.threadId,
              child.title,
            ],
          );
          await scoped.execute(
            `update public.code_ui_sessions set chat_session_id = $1 where workspace_id = :workspace and id = $1 and root_session_id = $2`,
            [child.sessionId, root.id],
          );
        }
        await scoped.execute(
          `insert into public.code_ui_events (workspace_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
           select :workspace, $1::uuid, coalesce(max(seq), 0) + 1, $2, $3, $4::jsonb from public.code_ui_events where workspace_id = :workspace and root_session_id = $1::uuid`,
          [root.id, input.key, input.fingerprint, JSON.stringify(input.event)],
        );
        return true;
      });
    },
    /** 可信文件恢复消费者读原生提交；原文留在私有journal，不经UI展示字段重建。 */
    async readToolCompletions(
      workspaceId: string,
      rootSessionId: string,
      runId: string,
      limits: { maxEvents: number; maxBytes: number },
    ): Promise<Array<Extract<StreamEvent, { type: "tool.completed" }>>> {
      const scoped = persistence.forWorkspace(workspaceId);
      const root = await scoped.queryOne<SqlRow & { id: string }>(
        "select id from public.code_ui_sessions where workspace_id = :workspace and id = $1 and parent_session_id is null and deleted_at is null and state is not null",
        [rootSessionId],
      );
      if (!root)
        throw new CodeUiRepositoryError(
          "not_found",
          "文件提交所属Task已删除或不存在。",
        );
      const predicate =
        "workspace_id = :workspace and root_session_id = $1 and payload->>'type' = 'tool.completed' and payload->>'runId' = $2 and payload->>'toolName' in ('Write', 'Edit', 'ApplyPatch')";
      const totals = await scoped.queryOne<
        SqlRow & { count: string; bytes: string | null }
      >(
        `select count(*)::text as count, sum(octet_length(payload::text))::text as bytes from public.code_ui_events where ${predicate}`,
        [root.id, runId],
      );
      const rejectBudget = () => {
        throw new CodeUiRepositoryError(
          "command_conflict",
          "文件提交日志超过工作区恢复预算，请调整配置后重试。",
        );
      };
      if (
        Number(totals?.count ?? 0) > limits.maxEvents ||
        Number(totals?.bytes ?? 0) > limits.maxBytes
      )
        rejectBudget();
      const rows = await scoped.query<SqlRow & { payload: unknown }>(
        `select payload from public.code_ui_events where ${predicate} order by seq limit $3`,
        // 多读一条只用于识别并发追加导致的预算越界，不是额外运行额度。
        [root.id, runId, limits.maxEvents + 1],
      );
      if (
        rows.length > limits.maxEvents ||
        Buffer.byteLength(JSON.stringify(rows)) > limits.maxBytes
      )
        rejectBudget();
      return rows.map((row) => {
        const parsed = streamEventSchema.safeParse(row.payload);
        if (!parsed.success || parsed.data.type !== "tool.completed")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "持久文件提交日志不可读，不能安全恢复。",
          );
        return parsed.data;
      });
    },
    async queryCommands(
      workspaceId: string,
      clientId: string,
      keys: protocol.CommandKey[],
    ): Promise<protocol.CommandsQueryResult> {
      const results = await Promise.all(
        keys.map(async (key) => {
          const row = await persistence
            .forWorkspace(workspaceId)
            .queryOne<SqlRow & { ack: protocol.CommandAck | null }>(
              "select ack from public.code_ui_commands where workspace_id = :workspace and client_id = $1 and command_id = $2 and ($3::uuid is null or session_id = $3::uuid)",
              [clientId, key.commandId, key.sessionId],
            );
          return { key, result: row?.ack ?? ("unknown" as const) };
        }),
      );
      return protocol.commandsQueryResultSchema.parse({ results });
    },
    async save(
      workspaceId: string,
      rootSessionId: string,
      expectedRevision: number,
      state: CodeUiConversationState,
      activeRunId: string | null,
    ) {
      await persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        const root = await scoped.queryOne<CodeUiSessionRecord>(
          "select * from public.code_ui_sessions where workspace_id = :workspace and id = $1 and deleted_at is null for update",
          [rootSessionId],
        );
        if (!root)
          throw new CodeUiRepositoryError(
            "not_found",
            "Code 会话已删除或不存在",
          );
        if (Number(root.revision) !== expectedRevision)
          throw new CodeUiRepositoryError(
            "revision_conflict",
            "Code 会话已被其它命令更新",
          );
        await writeState(scoped, root, state, activeRunId);
      });
    },
    async setListState(
      workspaceId: string,
      sessionId: string,
      state: { pinned?: boolean; archived?: boolean },
    ) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_ui_sessions set pinned = coalesce($2, pinned), archived = coalesce($3, archived), revision = revision + 1, updated_at = now()
          where workspace_id = :workspace and id = $1 and deleted_at is null`,
        [sessionId, state.pinned ?? null, state.archived ?? null],
      );
    },
    async delete(workspaceId: string, rootSessionId: string) {
      await persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        await scoped.execute(
          `update public.code_ui_sessions set deleted_at = now(), state = null, parent_tool_call_id = null, active_run_id = null, root_directory = null, additional_directories = null, scope_generation = scope_generation + 1, execution_state = 'failed', revision = revision + 1
            where workspace_id = :workspace and root_session_id = $1 and deleted_at is null`,
          [rootSessionId],
        );
        await scoped.execute(
          "delete from public.code_ui_events where workspace_id = :workspace and root_session_id = $1",
          [rootSessionId],
        );
        await scoped.execute(
          "delete from public.code_ui_outputs where workspace_id = :workspace and root_session_id = $1",
          [rootSessionId],
        );
        await scoped.execute(
          `update public.code_ui_commands set status = 'deleted', parameter_fingerprint = null, ack = null
            where workspace_id = :workspace and session_id in
            (select id from public.code_ui_sessions where workspace_id = :workspace and root_session_id = $1)`,
          [rootSessionId],
        );
      });
    },
  };
}

export type CodeUiRepository = ReturnType<typeof createCodeUiRepository>;
