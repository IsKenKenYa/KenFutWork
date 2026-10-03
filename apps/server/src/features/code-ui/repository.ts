import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type {
  PersistenceService,
  SqlRow,
  WorkspaceSqlClient,
} from "../persistence/types.js";
import type { CodeUiConversationState } from "./conversation.js";

export type CodeUiSessionRecord = SqlRow & {
  id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
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
        `insert into public.code_ui_sessions (id, workspace_id, project_id, canvas_id, root_session_id, parent_session_id, parent_tool_call_id)
         values ($1, :workspace, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
        [
          row.childSessionId,
          root.project_id,
          root.canvas_id,
          root.id,
          snapshot.sessionId,
          row.parentToolCallId,
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
    async createRoot(
      workspaceId: string,
      input: {
        sessionId: string;
        projectId: string;
        canvasId: string;
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
        const canvas = await scoped.queryOne<SqlRow & { id: string }>(
          `select c.id from public.canvases c join public.projects p on p.id = c.project_id
           where p.workspace_id = :workspace and p.id = $1 and p.kind = 'code' and p.archived_at is null and c.id = $2 and c.is_primary = true
           for update of p, c`,
          [input.projectId, input.canvasId],
        );
        if (!canvas)
          throw new CodeUiRepositoryError(
            "not_found",
            "Code 项目的主工作目录不存在",
          );
        await scoped.execute(
          `insert into public.chat_sessions (id, canvas_id, created_by, thread_id)
           select $1::uuid, c.id, $3::uuid, $4::text from public.canvases c
           join public.projects p on p.id = c.project_id
           where c.id = $2::uuid and p.workspace_id = :workspace`,
          [input.sessionId, input.canvasId, input.userId, input.threadId],
        );
        await scoped.execute(
          `insert into public.code_ui_sessions (id, workspace_id, project_id, canvas_id, chat_session_id, root_session_id, state)
           values ($1, :workspace, $2, $3, $1, $1, $4::jsonb)`,
          [
            input.sessionId,
            input.projectId,
            input.canvasId,
            JSON.stringify(input.state),
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
      canvasId: string,
    ): Promise<CodeUiSessionRecord[]> {
      return persistence.forWorkspace(workspaceId).query<CodeUiSessionRecord>(
        `select * from public.code_ui_sessions
          where workspace_id = :workspace and canvas_id = $1 and parent_session_id is null and deleted_at is null
          order by updated_at desc, id`,
        [canvasId],
      );
    },
    async listRoots(workspaceId: string): Promise<CodeUiSessionRecord[]> {
      return persistence.forWorkspace(workspaceId).query<CodeUiSessionRecord>(
        `select s.* from public.code_ui_sessions s join public.projects p on p.id = s.project_id
         where s.workspace_id = :workspace and p.workspace_id = :workspace and p.kind = 'code' and p.archived_at is null
           and s.parent_session_id is null order by s.updated_at desc, s.id`,
      );
    },
    async listVersion(workspaceId: string, canvasId: string): Promise<number> {
      // 包含删除墓碑，列表序号不会因删除或归档倒退。
      const record = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SqlRow & { seq: string }>(
          "select coalesce(sum(revision + 1), 0)::text as seq from public.code_ui_sessions where workspace_id = :workspace and canvas_id = $1 and parent_session_id is null",
          [canvasId],
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
    async startRunIfCurrent(
      workspaceId: string,
      rootSessionId: string,
      runId: string,
      start: () => void,
    ): Promise<boolean> {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(workspaceId);
        const root = await lockRoot(scoped, rootSessionId);
        if (
          root.active_run_id !== runId ||
          root.state?.runId !== runId ||
          root.state.closedRuns.includes(runId)
        )
          return false;
        const project = await lockActiveProject(scoped, root);
        if (!project) return false;
        // 只登记同步运行句柄，不执行模型 I/O；与 Stop 的同一根锁消除检查/启动窗口。
        start();
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
        await scoped.execute(
          `insert into public.code_ui_events (workspace_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
           select :workspace, $1::uuid, coalesce(max(seq), 0) + 1, $2, $3, $4::jsonb from public.code_ui_events where workspace_id = :workspace and root_session_id = $1::uuid`,
          [root.id, input.key, input.fingerprint, JSON.stringify(input.event)],
        );
        return true;
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
          `update public.code_ui_sessions set deleted_at = now(), state = null, parent_tool_call_id = null, active_run_id = null, revision = revision + 1
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
