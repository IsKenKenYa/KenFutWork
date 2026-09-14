import type { WorkspaceSettings } from "@loomic/shared";

import {
  clampMaxRunRetries,
  DEFAULT_MAX_RUN_RETRIES,
} from "../../agent/run-retry.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { SettingsRepository } from "./repository.js";

const FALLBACK_MODEL = "gpt-5.4-mini";

type SettingsErrorCode =
  | "settings_not_found"
  | "settings_read_failed"
  | "settings_update_failed";

export class SettingsServiceError extends Error {
  readonly statusCode: number;
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "SettingsServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SettingsService = {
  getWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<WorkspaceSettings>;
  updateWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
    settings: WorkspaceSettings,
  ): Promise<WorkspaceSettings>;
};

export function createSettingsService(options: {
  repository: SettingsRepository;
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;
  const { repository } = options;

  return {
    async getWorkspaceSettings(_user, workspaceId) {
      const [storedModel, storedRetries] = await Promise.all([
        repository.findDefaultModel(workspaceId),
        repository.findAgentMaxRetries(workspaceId),
      ]).catch(() => {
        throw new SettingsServiceError(
          "settings_read_failed",
          "Unable to load workspace settings.",
          500,
        );
      });

      return {
        agentMaxRetries: clampMaxRunRetries(
          storedRetries ?? DEFAULT_MAX_RUN_RETRIES,
        ),
        defaultModel: storedModel ?? defaultModel,
      };
    },

    async updateWorkspaceSettings(_user, workspaceId, settings) {
      const retries = clampMaxRunRetries(settings.agentMaxRetries);
      // 逐列 upsert（各写各的列）——两个设置之间不会互相覆盖
      await Promise.all([
        repository.upsertDefaultModel(workspaceId, settings.defaultModel),
        repository.upsertAgentMaxRetries(workspaceId, retries),
      ]).catch(() => {
        throw new SettingsServiceError(
          "settings_update_failed",
          "Unable to update workspace settings.",
          500,
        );
      });

      return { ...settings, agentMaxRetries: retries };
    },
  };
}
