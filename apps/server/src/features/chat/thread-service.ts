import { randomUUID } from "node:crypto";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { ChatRepository } from "./repository.js";

export class ThreadServiceError extends Error {
  readonly statusCode: number;
  readonly code: "session_not_found" | "session_unavailable";

  constructor(
    message: string,
    statusCode: number,
    code: ThreadServiceError["code"] = "session_not_found",
  ) {
    super(message);
    this.name = "ThreadServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SessionThreadBinding = {
  sessionId: string;
  threadId: string;
  /** 可视化模式的视图身份；Code 作用域只使用 projectId/sessionId。 */
  canvasId?: string;
  projectId: string;
  mode: "design" | "code" | "flow";
};

export type ThreadService = {
  createThreadId(): string;
  resolveOwnedSessionThread(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<SessionThreadBinding>;
};

export function createThreadService(options: {
  /** 会话属主经 project/workspace 身份校验；Code 不再经 Canvas。 */
  repository: ChatRepository;
  threadIdFactory?: () => string;
  viewerService: ViewerService;
}): ThreadService {
  const threadIdFactory =
    options.threadIdFactory ?? (() => `thread_${randomUUID()}`);

  return {
    createThreadId() {
      return threadIdFactory();
    },

    async resolveOwnedSessionThread(user, sessionId) {
      const workspace = await options.viewerService
        .resolveWorkspace(user)
        .catch(() => {
          throw new ThreadServiceError(
            "工作区暂不可用，请稍后重新打开会话。",
            503,
            "session_unavailable",
          );
        });

      if (!workspace) {
        throw new ThreadServiceError("Session not found.", 404);
      }

      const row = await options.repository.findSessionThread(
        workspace.id,
        sessionId,
      );

      if (!row) {
        throw new ThreadServiceError("Session not found.", 404);
      }

      if (!row.thread_id) {
        throw new ThreadServiceError(
          "Session is not resumable because no thread is bound yet.",
          409,
        );
      }

      return {
        ...(row.mode !== "code" && row.canvas_id
          ? { canvasId: row.canvas_id }
          : {}),
        projectId: row.project_id,
        mode: row.mode,
        sessionId: row.id,
        threadId: row.thread_id,
      };
    },
  };
}
