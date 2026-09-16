import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
} from "@kenfutwork/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
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
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<ChatSessionSummary[]>;
  createSession(
    user: AuthenticatedUser,
    canvasId: string,
    title?: string,
  ): Promise<ChatSessionSummary>;
  /**
   * 供给 **Code 模式会话**（方案 A）：工作区懒建一个隐藏的「Code 工作台」项目 + 主画布
   * 作为载体，再以客户端给的 `sessionId` 落会话行并绑定线程；已存在则复用既有线程。
   *
   * 为什么需要它：Code 模式工作台用客户端自造 id 发起 run，库里没有对应 `chat_sessions`
   * 行 → 线程解析失败（没有多轮上下文、`agent_runs` 不落库）且助手消息被丢弃。这里把
   * 「客户端造 id」升级为「服务端按该 id 供给真实会话」，前端协议形状不变。
   */
  ensureCodeSession(
    user: AuthenticatedUser,
    input: { sessionId: string; title?: string | undefined },
  ): Promise<{ sessionId: string; threadId: string }>;
  updateSessionTitle(
    user: AuthenticatedUser,
    sessionId: string,
    title: string,
  ): Promise<void>;
  deleteSession(user: AuthenticatedUser, sessionId: string): Promise<void>;
  listMessages(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ChatMessage[]>;
  createMessage(
    user: AuthenticatedUser,
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

/** 会话 id 必须是 uuid（库内是 uuid 主键）。 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createChatService(options: {
  repository: ChatRepository;
  threadService: Pick<ThreadService, "createThreadId">;
  viewerService: ViewerService;
  /**
   * Code 模式会话载体的供给（projects 聚合的能力，窄接口注入以免跨聚合直连）。
   * 由 chat 插件从持久层构造后传入。
   */
  codeWorkbench: {
    ensureCodeWorkbench(input: {
      userId: string;
      workspaceId: string;
    }): Promise<{ canvasId: string; projectId: string }>;
  };
}): ChatService {
  const { repository, viewerService } = options;

  /** 工作区一律由服务端从鉴权用户解析（`FORM-9`）。 */
  const requireWorkspaceId = async (
    user: AuthenticatedUser,
    message: string,
  ) => {
    const workspace = await viewerService
      .resolveWorkspace(user)
      .catch(() => null);

    if (!workspace) {
      throw new ChatServiceError("chat_error", message, 500);
    }

    return workspace.id;
  };

  return {
    async listSessions(user, canvasId) {
      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to list sessions.",
      );

      const rows = await repository
        .listSessions(workspaceId, canvasId)
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
      }));
    },

    async ensureCodeSession(user, input) {
      if (!UUID_PATTERN.test(input.sessionId)) {
        // 会话 id 是库里的 uuid 主键；非 uuid 直接拒绝（fail loud，不静默换 id）
        throw new ChatServiceError(
          "chat_error",
          "Session id must be a UUID.",
          400,
        );
      }

      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to prepare code session.",
      );

      // 快路径：会话已存在（含线程）直接回，不跑载体供给
      const known = await repository
        .findSessionThread(workspaceId, input.sessionId)
        .catch(() => null);
      if (known?.thread_id) {
        return { sessionId: known.id, threadId: known.thread_id };
      }

      const workbench = await options.codeWorkbench
        .ensureCodeWorkbench({ userId: user.id, workspaceId })
        .catch(() => null);
      if (!workbench) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to prepare code workbench.",
          500,
        );
      }

      const threadId = options.threadService.createThreadId();
      const row = await repository
        .ensureSessionWithId(workspaceId, {
          canvasId: workbench.canvasId,
          sessionId: input.sessionId,
          threadId,
          userId: user.id,
          ...(input.title ? { title: input.title } : {}),
        })
        .catch((error: unknown) => {
          // 对外只给稳定错误码，原因留在服务端日志（不向客户端回显内部细节）
          console.error(
            "[chat] 供给 Code 会话失败：",
            error instanceof Error ? error.message : error,
          );
          return null;
        });
      if (!row) {
        throw new ChatServiceError(
          "chat_error",
          "Failed to prepare code session.",
          500,
        );
      }

      // 复用既有线程（多轮对话延续同一 thread），没有才用本次生成的
      return {
        sessionId: row.id,
        threadId: row.thread_id ?? threadId,
      };
    },

    async createSession(user, canvasId, title) {
      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to create session.",
      );

      const row = await repository
        .createSession(workspaceId, {
          canvasId,
          threadId: options.threadService.createThreadId(),
          userId: user.id,
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
      };
    },

    async updateSessionTitle(user, sessionId, title) {
      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to update session title.",
      );

      const affected = await repository
        .updateSessionTitle(workspaceId, sessionId, title)
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

    async deleteSession(user, sessionId) {
      const workspaceId = await requireWorkspaceId(user, "Session not found.");

      const affected = await repository
        .deleteSession(workspaceId, sessionId)
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

    async listMessages(user, sessionId) {
      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to list messages.",
      );

      const rows = await repository
        .listMessages(workspaceId, sessionId)
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
      return messages.filter(
        (msg, i) =>
          i === 0 ||
          msg.role !== messages[i - 1]!.role ||
          msg.content !== messages[i - 1]!.content,
      );
    },

    async createMessage(user, sessionId, input) {
      const workspaceId = await requireWorkspaceId(
        user,
        "Failed to save message.",
      );

      const row = await repository
        .insertMessage(workspaceId, {
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
      await repository.touchSession(workspaceId, sessionId).catch(() => 0);

      return toChatMessage(row);
    },
  };
}
