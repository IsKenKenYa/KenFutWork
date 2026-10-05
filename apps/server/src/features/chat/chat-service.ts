import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
} from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ChatMessageRow, ChatRepository } from "./repository.js";
import type { ThreadService } from "./thread-service.js";

export class ChatServiceError extends Error {
  readonly statusCode: number;
  readonly code: "chat_error" | "session_not_found";

  constructor(
    code: "chat_error" | "session_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "ChatServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ChatService = {
  listSessions(
    actor: LocalActor,
    canvasId: string,
  ): Promise<ChatSessionSummary[]>;
  createSession(
    actor: LocalActor,
    canvasId: string,
    title?: string,
  ): Promise<ChatSessionSummary>;
  updateSessionTitle(
    actor: LocalActor,
    sessionId: string,
    title: string,
  ): Promise<void>;
  deleteSession(actor: LocalActor, sessionId: string): Promise<void>;
  listMessages(actor: LocalActor, sessionId: string): Promise<ChatMessage[]>;
  createMessage(
    actor: LocalActor,
    sessionId: string,
    input: ChatMessageCreateRequest,
  ): Promise<ChatMessage>;
};

/**
 * Synthesize content blocks from legacy `content` + `tool_activities` columns.
 * Produces the same ordering the old client saw: text first, then tool blocks.
 */
function synthesizeLegacyBlocks(
  content: string | null,
  toolActivities: unknown[] | null,
): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  if (content) {
    blocks.push({ type: "text", text: content });
  }
  if (toolActivities && Array.isArray(toolActivities)) {
    for (const t of toolActivities) {
      blocks.push({
        type: "tool",
        ...(t as Omit<ContentBlock & { type: "tool" }, "type">),
      });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  const contentBlocks =
    Array.isArray(row.content_blocks) && row.content_blocks.length > 0
      ? (row.content_blocks as ContentBlock[])
      : synthesizeLegacyBlocks(
          row.content,
          row.tool_activities as unknown[] | null,
        );

  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: row.content,
    toolActivities: row.tool_activities as ChatMessage["toolActivities"],
    contentBlocks,
    createdAt: row.created_at,
  };
}

export function createChatService(options: {
  repository: ChatRepository;
  threadService: Pick<ThreadService, "createThreadId">;
  localInstance: LocalInstanceService;
}): ChatService {
  const { repository, localInstance } = options;
  const requireVisualSession = async (
    instanceId: string,
    sessionId: string,
  ) => {
    const session = await repository
      .findSessionThread(instanceId, sessionId)
      .catch(() => {
        throw new ChatServiceError(
          "chat_error",
          "会话暂不可用，请稍后重试。",
          503,
        );
      });
    if (!session || session.mode === "code")
      throw new ChatServiceError(
        "session_not_found",
        "此入口只接受画布会话。",
        404,
      );
  };

  const requireInstanceId = async (actor: LocalActor) =>
    (await localInstance.resolve(actor)).instanceId;

  return {
    async listSessions(actor, canvasId) {
      const instanceId = await requireInstanceId(actor);

      const rows = await repository
        .listSessions(instanceId, canvasId)
        .catch(() => {
          throw new ChatServiceError(
            "chat_error",
            "Failed to list sessions.",
            500,
          );
        });

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        projectId: row.project_id,
        mode: row.mode,
      }));
    },

    async createSession(actor, canvasId, title) {
      const instanceId = await requireInstanceId(actor);

      const row = await repository
        .createSession(instanceId, {
          canvasId,
          threadId: options.threadService.createThreadId(),
          createdByClientId: actor.accessClientId,
          ...(title ? { title } : {}),
        })
        .catch(() => null);

      // 0 行 = 画布不属本工作区（旧实现由 RLS 拒绝插入并报错，映射保持一致）。
      if (!row) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to create session.",
          500,
        );
      }

      return {
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        projectId: row.project_id,
        mode: row.mode,
      };
    },

    async updateSessionTitle(actor, sessionId, title) {
      const instanceId = await requireInstanceId(actor);
      await requireVisualSession(instanceId, sessionId);

      const affected = await repository
        .updateSessionTitle(instanceId, sessionId, title)
        .catch(() => {
          throw new ChatServiceError(
            "chat_error",
            "Failed to update session title.",
            500,
          );
        });

      // 0 行 = 不存在或不属本工作区；旧实现经 RLS 静默成功，此处显式 404。
      if (affected === 0) {
        throw new ChatServiceError(
          "session_not_found",
          "Session not found.",
          404,
        );
      }
    },

    async deleteSession(actor, sessionId) {
      const instanceId = await requireInstanceId(actor);
      await requireVisualSession(instanceId, sessionId);

      const affected = await repository
        .deleteSession(instanceId, sessionId)
        .catch(() => {
          throw new ChatServiceError(
            "session_not_found",
            "Session not found.",
            404,
          );
        });

      if (affected === 0) {
        throw new ChatServiceError(
          "session_not_found",
          "Session not found.",
          404,
        );
      }
    },

    async listMessages(actor, sessionId) {
      const instanceId = await requireInstanceId(actor);
      await requireVisualSession(instanceId, sessionId);

      const rows = await repository
        .listMessages(instanceId, sessionId)
        .catch(() => {
          throw new ChatServiceError(
            "chat_error",
            "Failed to list messages.",
            500,
          );
        });

      const messages = rows.map(toChatMessage);

      // Deduplicate consecutive messages with same role + content
      // (caused by dual client+server save in earlier versions)
      return messages.filter((msg, i) => {
        const prev = i > 0 ? messages[i - 1] : undefined;
        return (
          prev === undefined ||
          msg.role !== prev.role ||
          msg.content !== prev.content
        );
      });
    },

    async createMessage(actor, sessionId, input) {
      const instanceId = await requireInstanceId(actor);
      await requireVisualSession(instanceId, sessionId);

      const row = await repository
        .insertMessage(instanceId, {
          sessionId,
          role: input.role,
          content: input.content,
          ...(input.toolActivities
            ? { toolActivities: input.toolActivities }
            : {}),
          ...(input.contentBlocks
            ? { contentBlocks: input.contentBlocks }
            : {}),
        })
        .catch(() => null);

      if (!row) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to save message.",
          500,
        );
      }

      // 会话排序时间随消息推进（消息表更新不会触发会话触发器）；失败不影响消息已落库。
      await repository.touchSession(instanceId, sessionId).catch(() => 0);

      return toChatMessage(row);
    },
  };
}
