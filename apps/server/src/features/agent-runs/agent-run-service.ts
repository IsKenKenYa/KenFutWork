import type { AgentRunRepository } from "./repository.js";
import type {
  CreateAcceptedAgentRunInput,
  UpdateAgentRunInput,
} from "./types.js";

export class AgentRunPersistenceError extends Error {
  readonly statusCode: number;
  readonly code: "application_error";

  constructor(message: string, statusCode = 500) {
    super(message);
    this.code = "application_error";
    this.statusCode = statusCode;
  }
}

export type AgentRunMetadataService = {
  createAcceptedRun(input: CreateAcceptedAgentRunInput): Promise<void>;
  updateRun(input: UpdateAgentRunInput): Promise<void>;
};

/** 运行活动窗口（天）：Git 弹层那一行按近 7 天统计。 */
export const AGENT_ACTIVITY_WINDOW_DAYS = 7;

/**
 * 工作区的 agent 运行活动（近 `AGENT_ACTIVITY_WINDOW_DAYS` 天）：次数 + 累计时长（秒）。
 * 口径写在仓储方法上（`workspaceActivity`），这里只负责算窗口起点。
 */
export function createAgentActivityQuery(options: {
  now?: () => Date;
  repository: AgentRunRepository;
}) {
  const now = options.now ?? (() => new Date());
  return async function workspaceActivity(input: {
    workspaceId: string;
  }): Promise<{ runs: number; totalSeconds: number; windowDays: number }> {
    const since = new Date(
      now().getTime() - AGENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const activity = await options.repository.workspaceActivity({
      since,
      workspaceId: input.workspaceId,
    });
    return { windowDays: AGENT_ACTIVITY_WINDOW_DAYS, ...activity };
  };
}

export function createAgentRunMetadataService(options: {
  repository: AgentRunRepository;
}): AgentRunMetadataService {
  const { repository } = options;

  return {
    async createAcceptedRun(input) {
      await repository
        .insert({
          model: input.model ?? null,
          runId: input.runId,
          sessionId: input.sessionId,
          status: "accepted",
          threadId: input.threadId,
        })
        .catch(() => {
          throw new AgentRunPersistenceError("Failed to persist accepted run.");
        });
    },

    async updateRun(input) {
      const patch = {
        ...(input.completedAt ? { completed_at: input.completedAt } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
        status: input.status,
      };
      await repository.updateById(input.runId, patch).catch(() => {
        throw new AgentRunPersistenceError("Failed to update run metadata.");
      });
    },
  };
}
