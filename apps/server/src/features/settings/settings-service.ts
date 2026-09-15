import type { WorkspaceSettings } from "@kenfutwork/shared";

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
  /**
   * 无工作区设置时**动态解析**兜底模型（目录里首个可用的 chat 模型）。
   *
   * 为什么不能只用静态兜底：静态值来自 env（内置目录名，如 `gpt-4.1`），而实际可用模型
   * 由供应商实例决定——平台池只配了 GLM 时 `gpt-4.1` 在目录里根本不存在。不显式传 model
   * 的客户端（画布助手）会拿它起 run，上游直接拒绝：客户端只看到「处理过程中遇到问题」，
   * 服务端按可重试处理并重试满 10 次（实测 Design 模式面板整段不可用）。
   */
  resolveFallbackModel?: (
    user: AuthenticatedUser,
  ) => Promise<string | undefined>;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;
  const { repository } = options;

  return {
    async getWorkspaceSettings(user, workspaceId) {
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

      // 只在无库值时问目录：已显式设置过的工作区不额外付一次目录读
      const resolvedFallback =
        storedModel === null
          ? await options.resolveFallbackModel?.(user)
          : undefined;

      return {
        agentMaxRetries: clampMaxRunRetries(
          storedRetries ?? DEFAULT_MAX_RUN_RETRIES,
        ),
        defaultModel: storedModel ?? resolvedFallback ?? defaultModel,
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
