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
