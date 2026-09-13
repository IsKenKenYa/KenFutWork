import type { PersistenceService } from "../persistence/types.js";

export type ChatSessionRow = {
  id: string;
  title: string;
  updated_at: string;
};

export type ChatSessionThreadRow = {
  id: string;
  thread_id: string | null;
};

export type ChatMessageRow = {
  id: string;
  role: string;
  /** `chat_messages.content` 是 NOT NULL default ''，故非空。 */
  content: string;
  tool_activities: unknown[] | null;
  content_blocks: unknown[] | null;
  created_at: string;
};

export type NewChatMessage = {
  sessionId: string;
  role: string;
  content: string;
  toolActivities?: unknown;
  contentBlocks?: unknown;
};

export type NewChatSession = {
  canvasId: string;
  /** 缺省即省略该列，由 `chat_sessions.title` 的默认值落库（不写 NULL）。 */
  title?: string | undefined;
  threadId: string;
  userId: string;
};

/**
 * chat 聚合的数据访问（`chat_sessions`/`chat_messages`）。
 * 两张表都没有 `workspace_id` 列，故一律经
 * `chat_sessions → canvases → projects` 链施加工作区谓词（`FORM-9`）。
 */
export interface ChatRepository {
  createSession(
    workspaceId: string,
    input: NewChatSession,
  ): Promise<ChatSessionRow | null>;
  deleteSession(workspaceId: string, sessionId: string): Promise<number>;
  findSessionThread(
    workspaceId: string,
    sessionId: string,
  ): Promise<ChatSessionThreadRow | null>;
  insertMessage(
    workspaceId: string,
    input: NewChatMessage,
  ): Promise<ChatMessageRow | null>;
  listMessages(
    workspaceId: string,
    sessionId: string,
  ): Promise<ChatMessageRow[]>;
  listSessions(
    workspaceId: string,
    canvasId: string,
  ): Promise<ChatSessionRow[]>;
  /** 追加消息后推进会话排序时间（`chat_sessions` 触发器只认本表更新）。 */
  touchSession(workspaceId: string, sessionId: string): Promise<number>;
  updateSessionTitle(
    workspaceId: string,
    sessionId: string,
    title: string,
  ): Promise<number>;
}

const SESSION_COLUMNS = "s.id, s.title, s.updated_at";
const MESSAGE_COLUMNS =
  "m.id, m.role, m.content, m.tool_activities, m.content_blocks, m.created_at";

export function createChatRepository(
  persistence: PersistenceService,
): ChatRepository {
  return {
    async listSessions(workspaceId, canvasId) {
      return persistence.forWorkspace(workspaceId).query<ChatSessionRow>(
        `select ${SESSION_COLUMNS}
           from public.chat_sessions s
           join public.canvases c on c.id = s.canvas_id
           join public.projects p on p.id = c.project_id
          where s.canvas_id = $1
            and p.workspace_id = :workspace
          order by s.updated_at desc`,
        [canvasId],
      );
    },

    async createSession(workspaceId, input) {
      // title 为 NOT NULL 带默认值：缺省时必须省略该列而不是写 NULL。
      const withTitle = input.title !== undefined;
      const columns = withTitle
        ? "(canvas_id, created_by, thread_id, title)"
        : "(canvas_id, created_by, thread_id)";
      const selectList = withTitle ? "$2, $3, $4" : "$2, $3";
      const params = withTitle
        ? [input.canvasId, input.userId, input.threadId, input.title]
        : [input.canvasId, input.userId, input.threadId];

      return persistence.forWorkspace(workspaceId).queryOne<ChatSessionRow>(
        `insert into public.chat_sessions ${columns}
         select c.id, ${selectList}
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where c.id = $1
            and p.workspace_id = :workspace
         returning id, title, updated_at`,
        params,
      );
    },

    async updateSessionTitle(workspaceId, sessionId, title) {
      return persistence.forWorkspace(workspaceId).execute(
        `update public.chat_sessions s
            set title = $1
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where c.id = s.canvas_id
            and s.id = $2
            and p.workspace_id = :workspace`,
        [title, sessionId],
      );
    },

    async deleteSession(workspaceId, sessionId) {
      return persistence.forWorkspace(workspaceId).execute(
        `delete from public.chat_sessions s
          using public.canvases c, public.projects p
          where c.id = s.canvas_id
            and p.id = c.project_id
            and s.id = $1
            and p.workspace_id = :workspace`,
        [sessionId],
      );
    },

    async findSessionThread(workspaceId, sessionId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<ChatSessionThreadRow>(
          `select s.id, s.thread_id
             from public.chat_sessions s
             join public.canvases c on c.id = s.canvas_id
             join public.projects p on p.id = c.project_id
            where s.id = $1
              and p.workspace_id = :workspace`,
          [sessionId],
        );
      return row ?? null;
    },

    async listMessages(workspaceId, sessionId) {
      return persistence.forWorkspace(workspaceId).query<ChatMessageRow>(
        `select ${MESSAGE_COLUMNS}
           from public.chat_messages m
           join public.chat_sessions s on s.id = m.session_id
           join public.canvases c on c.id = s.canvas_id
           join public.projects p on p.id = c.project_id
          where m.session_id = $1
            and p.workspace_id = :workspace
          order by m.created_at asc`,
        [sessionId],
      );
    },

    async insertMessage(workspaceId, input) {
      const toolActivities =
        input.toolActivities === undefined
          ? null
          : JSON.stringify(input.toolActivities);
      const contentBlocks =
        input.contentBlocks === undefined
          ? null
          : JSON.stringify(input.contentBlocks);

      return persistence.forWorkspace(workspaceId).queryOne<ChatMessageRow>(
        `insert into public.chat_messages
                (session_id, role, content, tool_activities, content_blocks)
         select s.id, $2, $3, $4::jsonb, $5::jsonb
           from public.chat_sessions s
           join public.canvases c on c.id = s.canvas_id
           join public.projects p on p.id = c.project_id
          where s.id = $1
            and p.workspace_id = :workspace
         returning ${MESSAGE_COLUMNS.replaceAll("m.", "")}`,
        [
          input.sessionId,
          input.role,
          input.content,
          toolActivities,
          contentBlocks,
        ],
      );
    },

    async touchSession(workspaceId, sessionId) {
      return persistence.forWorkspace(workspaceId).execute(
        `update public.chat_sessions s
            set updated_at = now()
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where c.id = s.canvas_id
            and s.id = $1
            and p.workspace_id = :workspace`,
        [sessionId],
      );
    },
  };
}
