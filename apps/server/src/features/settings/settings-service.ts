import type { WorkspaceSettings } from "@loomic/shared";

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
      const stored = await repository
        .findDefaultModel(workspaceId)
        .catch(() => {
          throw new SettingsServiceError(
            "settings_read_failed",
            "Unable to load workspace settings.",
            500,
          );
        });

      return { defaultModel: stored ?? defaultModel };
    },

    async updateWorkspaceSettings(_user, workspaceId, settings) {
      await repository
        .upsertDefaultModel(workspaceId, settings.defaultModel)
        .catch(() => {
          throw new SettingsServiceError(
            "settings_update_failed",
            "Unable to update workspace settings.",
            500,
          );
        });

      return settings;
    },
  };
}
