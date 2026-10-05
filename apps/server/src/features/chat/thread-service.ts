import { randomUUID } from "node:crypto";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
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
    actor: LocalActor,
    sessionId: string,
  ): Promise<SessionThreadBinding>;
};

export function createThreadService(options: {
  /** 会话属主经 project/instance 身份校验；Code 不再经 Canvas。 */
  repository: ChatRepository;
  threadIdFactory?: () => string;
  localInstance: LocalInstanceService;
}): ThreadService {
  const threadIdFactory =
    options.threadIdFactory ?? (() => `thread_${randomUUID()}`);

  return {
    createThreadId() {
      return threadIdFactory();
    },

    async resolveOwnedSessionThread(actor, sessionId) {
      const context = await options.localInstance.resolve(actor);

      const row = await options.repository.findSessionThread(
        context.instanceId,
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
