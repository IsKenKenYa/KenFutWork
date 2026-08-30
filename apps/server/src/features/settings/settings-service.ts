import type { WorkspaceSettings } from "@loomic/shared";

import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const FALLBACK_MODEL = "gpt-5.4-mini";

export class SettingsServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "settings_not_found"
    | "settings_read_failed"
    | "settings_update_failed";

  constructor(
    code:
      | "settings_not_found"
      | "settings_read_failed"
      | "settings_update_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
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
  createUserClient: (accessToken: string) => UserSupabaseClient;
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;

  return {
    async getWorkspaceSettings(user, workspaceId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("workspace_settings")
        .select("default_model")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) {
        throw new SettingsServiceError(
          "settings_read_failed",
          "Unable to load workspace settings.",
          500,
        );
      }

      return {
        defaultModel: data?.default_model ?? defaultModel,
      };
    },

    async updateWorkspaceSettings(user, workspaceId, settings) {
      const client = options.createUserClient(user.accessToken);
      const { error } = await client.from("workspace_settings").upsert(
        {
          workspace_id: workspaceId,
          default_model: settings.defaultModel,
        },
        { onConflict: "workspace_id" },
      );

      if (error) {
        throw new SettingsServiceError(
          "settings_update_failed",
          "Unable to update workspace settings.",
          500,
        );
      }

      return settings;
    },
  };
}
