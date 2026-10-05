import type { ThreadService } from "../chat/thread-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { AgentRunRepository } from "./repository.js";
import type {
  AgentTurnBoundaries,
  AgentTurnBoundary,
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

export class AgentTurnBoundaryError extends Error {
  constructor(
    readonly code: "turn_boundary_conflict" | "not_found",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentTurnBoundaryError";
  }
}

export type AgentRunMetadataService = {
  recordTurnBoundary(input: AgentTurnBoundary): Promise<void>;
  getOwnedTurnBoundaries(
    actor: LocalActor,
    input: { taskId: string; runId: string },
  ): Promise<AgentTurnBoundaries>;
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
    instanceId: string;
  }): Promise<{ runs: number; totalSeconds: number; windowDays: number }> {
    const since = new Date(
      now().getTime() - AGENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const activity = await options.repository.workspaceActivity({
      since,
      instanceId: input.instanceId,
    });
    return { windowDays: AGENT_ACTIVITY_WINDOW_DAYS, ...activity };
  };
}

export function createAgentRunMetadataService(options: {
  repository: AgentRunRepository;
  localInstance?: Pick<LocalInstanceService, "resolve">;
  threadService?: Pick<ThreadService, "resolveOwnedSessionThread">;
}): AgentRunMetadataService {
  const { repository } = options;

  return {
    async recordTurnBoundary(input) {
      if (!(await repository.recordTurnBoundary(input)))
        throw new AgentTurnBoundaryError(
          "turn_boundary_conflict",
          "同一Run/phase不能保存不同轮次事实，或其Task归属已不可用。",
          409,
        );
    },
    async getOwnedTurnBoundaries(actor, input) {
      if (!options.localInstance || !options.threadService)
        throw new AgentRunPersistenceError("轮次历史读取服务未装配。");
      const workspace = await options.localInstance
        .resolve(actor)
        .catch(() => null);
      const binding = workspace
        ? await options.threadService
            .resolveOwnedSessionThread(actor, input.taskId)
            .catch(() => null)
        : null;
      if (!workspace || !binding || binding.mode !== "code")
        throw new AgentTurnBoundaryError(
          "not_found",
          "Code Task不存在或不属于当前用户。",
          404,
        );
      return repository.getTurnBoundaries({
        instanceId: workspace.instanceId,
        projectId: binding.projectId,
        taskId: input.taskId,
        runId: input.runId,
        threadId: binding.threadId,
      });
    },
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
