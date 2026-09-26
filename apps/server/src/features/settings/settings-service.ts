import type {
  AgentGovernanceOverrides,
  TerminalShellId,
  WorkspaceSettings,
} from "@kenfutwork/shared";

import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampExecuteTimeoutMs,
  clampLlmRequestMaxRetries,
  clampSubagentMaxConcurrency,
  clampSubagentMaxContinuations,
  clampSubagentMaxDepth,
  coerceLlmInfiniteRetry,
} from "@kenfutwork/shared";
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
  commands?: WorkspaceSettings["commands"] | undefined;
  hooks?: WorkspaceSettings["hooks"] | undefined;
  userRules?: string | undefined;
  ruleEntries?: string[] | undefined;
  subagentMaxDepth?: number | undefined;
  subagentMaxConcurrency?: number | undefined;
  subagentMaxContinuations?: number | undefined;
  llmRequestMaxRetries?: number | undefined;
  llmInfiniteRetry?: boolean | undefined;
  executeTimeoutMs?: number | undefined;
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

/**
 * 读命令表：库里的 jsonb 只信形状对的那部分（旧数据/手改过的行不该让整页崩）。
 * 名字重复时**保留先出现的**——命令按名字触发，重名只会有一个生效。
 */
function parseCommands(raw: unknown): WorkspaceSettings["commands"] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WorkspaceSettings["commands"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, prompt } = entry as { name?: unknown; prompt?: unknown };
    const description = (entry as { description?: unknown }).description;
    if (typeof name !== "string" || typeof prompt !== "string") continue;
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(trimmedName)) continue;
    if (seen.has(trimmedName.toLowerCase())) continue;
    seen.add(trimmedName.toLowerCase());
    out.push({
      name: trimmedName,
      description:
        typeof description === "string" ? description.slice(0, 200) : "",
      prompt: trimmedPrompt.slice(0, 4_000),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 读钩子表：只信形状对的那部分（旧行/手改过的行不该让整页崩），最多 10 条。
 * 事件名认不出就丢——一个「不知道什么时候跑」的钩子比不跑更糟。
 */
function parseHooks(raw: unknown): WorkspaceSettings["hooks"] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceSettings["hooks"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { event, command } = entry as { event?: unknown; command?: unknown };
    if (event !== "turn-start" && event !== "turn-end") continue;
    if (typeof command !== "string" || !command.trim()) continue;
    out.push({ event, command: command.trim().slice(0, 2_000) });
    if (out.length >= 10) break;
  }
  return out;
}

export function createSettingsService(options: {
  repository: SettingsRepository;
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
  /**
   * agent 治理五项的 **env 兜底**（DEC-18）：优先级 = 库值 ?? env ?? DEFAULTS。
   * 自托管/桌面打包场景不改库也能调档（如 `KENFUTWORK_SUBAGENT_MAX_CONCURRENCY=8`）。
   */
  governanceEnv?: AgentGovernanceOverrides;
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
  const governanceEnv = options.governanceEnv ?? {};
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
      storedCommands,
      storedHooks,
      storedSubagentMaxDepth,
      storedSubagentMaxConcurrency,
      storedSubagentMaxContinuations,
      storedLlmRequestMaxRetries,
      storedLlmInfiniteRetry,
      storedExecuteTimeoutMs,
    ] = await Promise.all([
      repository.findDefaultModel(workspaceId),
      repository.findAgentMaxRetries(workspaceId),
      repository.findTerminalShell(workspaceId),
      repository.findCodeIndexEnabled(workspaceId),
      repository.findCodeIndexAutoNewFolder(workspaceId),
      repository.findAutoCompactEnabled(workspaceId),
      repository.findUserRules(workspaceId),
      repository.findCommands(workspaceId),
      repository.findHooks(workspaceId),
      repository.findSubagentMaxDepth(workspaceId),
      repository.findSubagentMaxConcurrency(workspaceId),
      repository.findSubagentMaxContinuations(workspaceId),
      repository.findLlmRequestMaxRetries(workspaceId),
      repository.findLlmInfiniteRetry(workspaceId),
      repository.findExecuteTimeoutMs(workspaceId),
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
      commands: parseCommands(storedCommands),
      hooks: parseHooks(storedHooks),
      userRules: storedRules?.userRules ?? "",
      ruleEntries: storedRules?.ruleEntries ?? [],
      // 治理五项（DEC-17/DEC-18）：默认值/护栏唯一属主是 shared governance.ts；
      // 优先级 = 库值 ?? env 兜底 ?? DEFAULTS，读侧一律钳回护栏
      subagentMaxDepth: clampSubagentMaxDepth(
        storedSubagentMaxDepth ??
          governanceEnv.subagentMaxDepth ??
          AGENT_GOVERNANCE_DEFAULTS.subagentMaxDepth,
      ),
      subagentMaxConcurrency: clampSubagentMaxConcurrency(
        storedSubagentMaxConcurrency ??
          governanceEnv.subagentMaxConcurrency ??
          AGENT_GOVERNANCE_DEFAULTS.subagentMaxConcurrency,
      ),
      subagentMaxContinuations: clampSubagentMaxContinuations(
        storedSubagentMaxContinuations ??
          governanceEnv.subagentMaxContinuations ??
          AGENT_GOVERNANCE_DEFAULTS.subagentMaxContinuations,
      ),
      llmRequestMaxRetries: clampLlmRequestMaxRetries(
        storedLlmRequestMaxRetries ??
          governanceEnv.llmRequestMaxRetries ??
          AGENT_GOVERNANCE_DEFAULTS.llmRequestMaxRetries,
      ),
      llmInfiniteRetry: coerceLlmInfiniteRetry(
        storedLlmInfiniteRetry ??
          governanceEnv.llmInfiniteRetry ??
          AGENT_GOVERNANCE_DEFAULTS.llmInfiniteRetry,
      ),
      executeTimeoutMs: clampExecuteTimeoutMs(
        storedExecuteTimeoutMs ??
          governanceEnv.executeTimeoutMs ??
          AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs,
      ),
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
      if (patch.hooks !== undefined) {
        writes.push(repository.upsertHooks(workspaceId, patch.hooks));
      }
      if (patch.commands !== undefined) {
        writes.push(repository.upsertCommands(workspaceId, patch.commands));
      }
      if (patch.userRules !== undefined) {
        writes.push(repository.upsertUserRules(workspaceId, patch.userRules));
      }
      if (patch.ruleEntries !== undefined) {
        writes.push(
          repository.upsertRuleEntries(workspaceId, patch.ruleEntries),
        );
      }
      if (patch.subagentMaxDepth !== undefined) {
        writes.push(
          repository.upsertSubagentMaxDepth(
            workspaceId,
            clampSubagentMaxDepth(patch.subagentMaxDepth),
          ),
        );
      }
      if (patch.subagentMaxConcurrency !== undefined) {
        writes.push(
          repository.upsertSubagentMaxConcurrency(
            workspaceId,
            clampSubagentMaxConcurrency(patch.subagentMaxConcurrency),
          ),
        );
      }
      if (patch.subagentMaxContinuations !== undefined) {
        writes.push(
          repository.upsertSubagentMaxContinuations(
            workspaceId,
            clampSubagentMaxContinuations(patch.subagentMaxContinuations),
          ),
        );
      }
      if (patch.llmRequestMaxRetries !== undefined) {
        writes.push(
          repository.upsertLlmRequestMaxRetries(
            workspaceId,
            clampLlmRequestMaxRetries(patch.llmRequestMaxRetries),
          ),
        );
      }
      if (patch.llmInfiniteRetry !== undefined) {
        writes.push(
          repository.upsertLlmInfiniteRetry(
            workspaceId,
            patch.llmInfiniteRetry,
          ),
        );
      }
      if (patch.executeTimeoutMs !== undefined) {
        writes.push(
          repository.upsertExecuteTimeoutMs(
            workspaceId,
            clampExecuteTimeoutMs(patch.executeTimeoutMs),
          ),
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
