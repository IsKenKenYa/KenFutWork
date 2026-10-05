import type { ProjectKind } from "@kenfutwork/shared";
import type { PersistenceService } from "../persistence/types.js";

export type ChatSessionRow = {
  id: string;
  title: string;
  updated_at: string;
  project_id: string;
  mode: ProjectKind;
};

export type ChatSessionThreadRow = {
  id: string;
  thread_id: string | null;
  /** 会话所属画布（沙箱目录名就用它，见 resolveSandboxDir 的调用方）。 */
  canvas_id: string | null;
  project_id: string;
  mode: ProjectKind;
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
  createdByClientId: string | null;
};

/**
 * chat 聚合的数据访问（`chat_sessions`/`chat_messages`）。
 * 会话以 instance/project 身份定权，消息经
 * `chat_messages → chat_sessions → projects` 施加实例谓词（`FORM-9`）。
 */
export interface ChatRepository {
  createSession(
    instanceId: string,
    input: NewChatSession,
  ): Promise<ChatSessionRow | null>;
  /**
   * 以指定 id 供给 Design/Flow 会话；Code Task 只由 CodeUi.createRoot 原子创建。
   *
   * 语义：不存在则插入（挂给定画布 + 线程）；已存在则回读并**复用其 `thread_id`**
   * （多轮必须同一 thread），仅当既有行没有线程时才绑定传入线程。幂等与并发安全靠
   * 主键冲突（`on conflict (id)`）＋事务。
   */
  ensureSessionWithId(
    instanceId: string,
    input: {
      canvasId: string;
      sessionId: string;
      threadId: string;
      title?: string | undefined;
      createdByClientId: string | null;
    },
  ): Promise<ChatSessionThreadRow | null>;
  deleteSession(instanceId: string, sessionId: string): Promise<number>;
  findSessionThread(
    instanceId: string,
    sessionId: string,
  ): Promise<ChatSessionThreadRow | null>;
  insertMessage(
    instanceId: string,
    input: NewChatMessage,
  ): Promise<ChatMessageRow | null>;
  listMessages(
    instanceId: string,
    sessionId: string,
  ): Promise<ChatMessageRow[]>;
  listSessions(instanceId: string, canvasId: string): Promise<ChatSessionRow[]>;
  /** 追加消息后推进会话排序时间（`chat_sessions` 触发器只认本表更新）。 */
  touchSession(instanceId: string, sessionId: string): Promise<number>;
  updateSessionTitle(
    instanceId: string,
    sessionId: string,
    title: string,
  ): Promise<number>;
}

const SESSION_COLUMNS = "s.id, s.title, s.updated_at, s.project_id, s.mode";
const MESSAGE_COLUMNS =
  "m.id, m.role, m.content, m.tool_activities, m.content_blocks, m.created_at";

export function createChatRepository(
  persistence: PersistenceService,
): ChatRepository {
  return {
    async listSessions(instanceId, canvasId) {
      return persistence.forInstance(instanceId).query<ChatSessionRow>(
        `select ${SESSION_COLUMNS}
           from public.chat_sessions s
           join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
          where s.canvas_id = $1
            and p.instance_id = :instance
          order by s.updated_at desc`,
        [canvasId],
      );
    },

    async createSession(instanceId, input) {
      // title 为 NOT NULL 带默认值：缺省时必须省略该列而不是写 NULL。
      const withTitle = input.title !== undefined;
      const columns = withTitle
        ? "(instance_id, project_id, mode, canvas_id, created_by_client_id, thread_id, title)"
        : "(instance_id, project_id, mode, canvas_id, created_by_client_id, thread_id)";
      const selectList = withTitle ? "$2, $3, $4" : "$2, $3";
      const params = withTitle
        ? [input.canvasId, input.createdByClientId, input.threadId, input.title]
        : [input.canvasId, input.createdByClientId, input.threadId];

      return persistence.forInstance(instanceId).queryOne<ChatSessionRow>(
        `insert into public.chat_sessions ${columns}
         select :instance, p.id, p.kind, c.id, ${selectList}
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where c.id = $1
            and p.instance_id = :instance and p.kind <> 'code'
         returning id, title, updated_at, project_id, mode`,
        params,
      );
    },

    async ensureSessionWithId(instanceId, input) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forInstance(instanceId);

        // 两个变体（带/不带标题）参数个数不同，故画布占位符要跟着算——
        // 写死会指向不存在的 $N（实测报 "could not determine data type of parameter $4"）。
        // 另：`insert … select` 形状下 Postgres **不反推参数类型**，select-list 与 where
        // 里的参数一律显式 cast。
        const withTitle = input.title !== undefined;
        const canvasParam = withTitle ? "$5" : "$4";

        // 画布必须属本实例（经 projects 父链校验）；不属则查不到，插不进去
        const inserted = await scoped.queryOne<ChatSessionThreadRow>(
          `insert into public.chat_sessions (id, instance_id, project_id, mode, canvas_id, created_by_client_id, thread_id${
            withTitle ? ", title" : ""
          })
           select $1::uuid, :instance, p.id, p.kind, c.id, $2::uuid, $3::text${
             withTitle ? ", $4::text" : ""
           }
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = ${canvasParam}::uuid
              and p.instance_id = :instance and p.kind <> 'code'
           on conflict (id) do nothing
           returning id, thread_id, canvas_id, project_id, mode`,
          [
            input.sessionId,
            input.createdByClientId,
            input.threadId,
            ...(withTitle ? [input.title] : []),
            input.canvasId,
          ],
        );
        if (inserted) {
          return inserted;
        }

        const existing = await scoped.queryOne<ChatSessionThreadRow>(
          `select s.id, s.thread_id, s.canvas_id, s.project_id, s.mode
             from public.chat_sessions s
             join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
            where s.id = $1
              and p.instance_id = :instance`,
          [input.sessionId],
        );
        if (
          !existing ||
          existing.mode === "code" ||
          existing.canvas_id !== input.canvasId
        ) {
          return null;
        }

        // 已有会话复用其线程（多轮必须同一 thread）；仅当没有线程时才绑定
        if (existing.thread_id) {
          return existing;
        }
        const bound = await scoped.queryOne<ChatSessionThreadRow>(
          `update public.chat_sessions s
              set thread_id = $1::text
             from public.projects p
            where p.id = s.project_id and s.instance_id = :instance
              and s.id = $2
              and s.thread_id is null
              and p.instance_id = :instance
           returning s.id, s.thread_id, s.canvas_id, s.project_id, s.mode`,
          [input.threadId, input.sessionId],
        );
        return bound ?? existing;
      });
    },

    async updateSessionTitle(instanceId, sessionId, title) {
      return persistence.forInstance(instanceId).execute(
        `update public.chat_sessions s
            set title = $1
           from public.projects p
          where p.id = s.project_id and s.instance_id = :instance
            and s.id = $2 and s.mode <> 'code'
            and p.instance_id = :instance`,
        [title, sessionId],
      );
    },

    async deleteSession(instanceId, sessionId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.chat_sessions s
          using public.projects p
          where p.id = s.project_id and s.instance_id = :instance
            and s.id = $1 and s.mode <> 'code'
            and p.instance_id = :instance`,
        [sessionId],
      );
    },

    async findSessionThread(instanceId, sessionId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<ChatSessionThreadRow>(
          `select s.id, s.thread_id, s.canvas_id, s.project_id, s.mode
             from public.chat_sessions s
             join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
            where s.id = $1
              and p.instance_id = :instance`,
          [sessionId],
        );
      return row ?? null;
    },

    async listMessages(instanceId, sessionId) {
      return persistence.forInstance(instanceId).query<ChatMessageRow>(
        `select ${MESSAGE_COLUMNS}
           from public.chat_messages m
           join public.chat_sessions s on s.id = m.session_id
           join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
          where m.session_id = $1 and s.mode <> 'code'
            and p.instance_id = :instance
          order by m.created_at asc`,
        [sessionId],
      );
    },

    async insertMessage(instanceId, input) {
      const toolActivities =
        input.toolActivities === undefined
          ? null
          : JSON.stringify(input.toolActivities);
      const contentBlocks =
        input.contentBlocks === undefined
          ? null
          : JSON.stringify(input.contentBlocks);

      return persistence.forInstance(instanceId).queryOne<ChatMessageRow>(
        `insert into public.chat_messages
                (session_id, role, content, tool_activities, content_blocks)
         select s.id, $2, $3, $4::jsonb, $5::jsonb
           from public.chat_sessions s
           join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id
          where s.id = $1 and s.mode <> 'code'
            and p.instance_id = :instance
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

    async touchSession(instanceId, sessionId) {
      return persistence.forInstance(instanceId).execute(
        `update public.chat_sessions s
            set updated_at = now()
           from public.projects p
          where p.id = s.project_id and s.instance_id = :instance
            and s.id = $1
            and p.instance_id = :instance`,
        [sessionId],
      );
    },
  };
}
