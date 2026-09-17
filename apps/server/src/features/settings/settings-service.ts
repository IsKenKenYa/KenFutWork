import type { TerminalShellId, WorkspaceSettings } from "@kenfutwork/shared";

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

/**
 * 部分更新：只带要改的字段。
 *
 * 每个字段显式写 `| undefined`：zod 的 `.partial()` 产出就是「键可缺、值可为 undefined」，
 * 而项目开着 `exactOptionalPropertyTypes`，用 `Partial<WorkspaceSettings>` 接会不兼容。
 */
export type WorkspaceSettingsPatch = {
  defaultModel?: string | undefined;
  agentMaxRetries?: number | undefined;
  terminalShell?: TerminalShellId | undefined;
  codeIndexEnabled?: boolean | undefined;
  codeIndexAutoNewFolder?: boolean | undefined;
  autoCompactEnabled?: boolean | undefined;
  userRules?: string | undefined;
  ruleEntries?: string[] | undefined;
};

export type SettingsService = {
  getWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<WorkspaceSettings>;
  /** 部分更新：只写送来的字段（未送的一律不动），返回更新后的完整设置。 */
  updateWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
    patch: WorkspaceSettingsPatch,
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

  const getSettings = async (
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<WorkspaceSettings> => {
    const [
      storedModel,
      storedRetries,
      storedShell,
      storedIndexEnabled,
      storedIndexAutoNewFolder,
      storedAutoCompact,
      storedRules,
    ] = await Promise.all([
      repository.findDefaultModel(workspaceId),
      repository.findAgentMaxRetries(workspaceId),
      repository.findTerminalShell(workspaceId),
      repository.findCodeIndexEnabled(workspaceId),
      repository.findCodeIndexAutoNewFolder(workspaceId),
      repository.findAutoCompactEnabled(workspaceId),
      repository.findUserRules(workspaceId),
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
      terminalShell: storedShell ?? "auto",
      codeIndexEnabled: storedIndexEnabled ?? false,
      // 缺省 true：只在上面那个总开关开着时才生效，所以不会「悄悄建索引」
      codeIndexAutoNewFolder: storedIndexAutoNewFolder ?? true,
      // 缺省 true：不压缩时超长会话直接撞上游上限失败，用户只能看到通用报错
      autoCompactEnabled: storedAutoCompact ?? true,
      userRules: storedRules?.userRules ?? "",
      ruleEntries: storedRules?.ruleEntries ?? [],
    };
  };

  return {
    getWorkspaceSettings: getSettings,

    async updateWorkspaceSettings(user, workspaceId, patch) {
      // 逐列 upsert（各写各的列）：没送来的字段一个字都不动
      const writes: Array<Promise<void>> = [];
      if (patch.defaultModel !== undefined) {
        writes.push(
          repository.upsertDefaultModel(workspaceId, patch.defaultModel),
        );
      }
      if (patch.agentMaxRetries !== undefined) {
        writes.push(
          repository.upsertAgentMaxRetries(
            workspaceId,
            clampMaxRunRetries(patch.agentMaxRetries),
          ),
        );
      }
      if (patch.terminalShell !== undefined) {
        writes.push(
          repository.upsertTerminalShell(workspaceId, patch.terminalShell),
        );
      }
      if (patch.codeIndexEnabled !== undefined) {
        writes.push(
          repository.upsertCodeIndexEnabled(
            workspaceId,
            patch.codeIndexEnabled,
          ),
        );
      }
      if (patch.codeIndexAutoNewFolder !== undefined) {
        writes.push(
          repository.upsertCodeIndexAutoNewFolder(
            workspaceId,
            patch.codeIndexAutoNewFolder,
          ),
        );
      }
      if (patch.autoCompactEnabled !== undefined) {
        writes.push(
          repository.upsertAutoCompactEnabled(
            workspaceId,
            patch.autoCompactEnabled,
          ),
        );
      }
      if (patch.userRules !== undefined) {
        writes.push(repository.upsertUserRules(workspaceId, patch.userRules));
      }
      if (patch.ruleEntries !== undefined) {
        writes.push(
          repository.upsertRuleEntries(workspaceId, patch.ruleEntries),
        );
      }
      await Promise.all(writes).catch(() => {
        throw new SettingsServiceError(
          "settings_update_failed",
          "Unable to update workspace settings.",
          500,
        );
      });

      // 回读真值：客户端拿到的是库里现在的事实，不是「我以为写成了什么」
      return getSettings(user, workspaceId);
    },
  };
}
