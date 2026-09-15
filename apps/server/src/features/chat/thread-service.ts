import { randomUUID } from "node:crypto";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { ChatRepository } from "./repository.js";

export class ThreadServiceError extends Error {
  readonly statusCode: number;
  readonly code: "session_not_found";

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ThreadServiceError";
    this.code = "session_not_found";
    this.statusCode = statusCode;
  }
}

export type SessionThreadBinding = {
  sessionId: string;
  threadId: string;
  /**
   * 会话所属画布 id。
   *
   * 用途：agent 的沙箱目录名取「画布 UUID」（`tmp/sandbox/<画布UUID>`）。无工作目录的
   * Code 会话，客户端只能拿会话 UUID 当 canvasId 发上来，直接落盘会得到
   * `tmp/sandbox/<会话UUID>`——与服务端懒供给的「Code 工作台」画布对不上。故运行入口
   * 用它把沙箱作用域改回真实画布（事件路由仍按客户端给的 canvasId，不受影响）。
   */
  canvasId: string;
};

export type ThreadService = {
  createThreadId(): string;
  resolveOwnedSessionThread(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<SessionThreadBinding>;
};

export function createThreadService(options: {
  /** 会话属主校验经持久层（`chat_sessions → canvases → projects` 链）。 */
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
        .catch(() => null);

      if (!workspace) {
        throw new ThreadServiceError("Session not found.", 404);
      }

      const row = await options.repository
        .findSessionThread(workspace.id, sessionId)
        .catch(() => null);

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
        canvasId: row.canvas_id,
        sessionId: row.id,
        threadId: row.thread_id,
      };
    },
  };
}
