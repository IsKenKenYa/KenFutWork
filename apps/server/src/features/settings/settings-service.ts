import type {
  AgentGovernanceOverrides,
  InstanceSettings,
  ModelDefaults,
  RuntimeGovernanceKey,
  TerminalShellId,
} from "@kenfutwork/shared";

import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampCodeUiReconnectDelayMs,
  clampComputerUseActionTimeoutMs,
  clampComputerUseMaxActionsPerRun,
  clampComputerUseObserveMaxBytes,
  clampComputerUseScreenshotMaxBytes,
  clampComputerUseSessionMaxMs,
  clampExecuteTimeoutMs,
  clampLlmRequestMaxRetries,
  clampSubagentMaxConcurrency,
  clampSubagentMaxContinuations,
  clampSubagentMaxDepth,
  coerceLlmInfiniteRetry,
  modelDefaultsSchema,
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";
import {
  clampMaxRunRetries,
  DEFAULT_MAX_RUN_RETRIES,
} from "../../agent/run-retry.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ModelCatalogService } from "../model-providers/model-catalog-service.js";
import { validateModelDefaults } from "../model-providers/model-defaults.js";
import type { SettingsRepository } from "./repository.js";
import { writeSettingsPatch } from "./settings-patch.js";

const FALLBACK_MODEL = "gpt-5.4-mini";

type SettingsErrorCode =
  | "invalid_model"
  | "settings_forbidden"
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
 * 而项目开着 `exactOptionalPropertyTypes`，用 `Partial<InstanceSettings>` 接会不兼容。
 */
export type InstanceSettingsPatch = Partial<
  Record<RuntimeGovernanceKey, number | undefined>
> & {
  modelDefaults?: ModelDefaults | undefined;
  codeUiReconnectDelayMs?: number | undefined;
  defaultModel?: string | undefined;
  agentMaxRetries?: number | undefined;
  terminalShell?: TerminalShellId | undefined;
  codeIndexEnabled?: boolean | undefined;
  codeIndexAutoNewFolder?: boolean | undefined;
  autoCompactEnabled?: boolean | undefined;
  commands?: InstanceSettings["commands"] | undefined;
  hooks?: InstanceSettings["hooks"] | undefined;
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
  onUpdated(
    listener: (event: {
      instanceId: string;
      changedKeys: readonly (keyof InstanceSettingsPatch)[];
    }) => void | Promise<void>,
  ): () => void;
  getCodeUiTransportSettings(
    actor: LocalActor,
    instanceId: string,
  ): Promise<{ reconnectDelayMs: number }>;
  getInstanceSettings(
    actor: LocalActor,
    instanceId: string,
  ): Promise<InstanceSettings>;
  /** 部分更新：只写送来的字段（未送的一律不动），返回更新后的完整设置。 */
  updateInstanceSettings(
    actor: LocalActor,
    instanceId: string,
    patch: InstanceSettingsPatch,
  ): Promise<InstanceSettings>;
};

/**
 * 读命令表：库里的 jsonb 只信形状对的那部分（旧数据/手改过的行不该让整页崩）。
 * 名字重复时**保留先出现的**——命令按名字触发，重名只会有一个生效。
 */
function parseCommands(raw: unknown): InstanceSettings["commands"] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: InstanceSettings["commands"] = [];
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
function parseHooks(raw: unknown): InstanceSettings["hooks"] {
  if (!Array.isArray(raw)) return [];
  const out: InstanceSettings["hooks"] = [];
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
  localInstance: LocalInstanceService;
  /** 模型默认写入必须有真实目录；仅治理读写的消费者可不提供。 */
  modelCatalog?: Pick<ModelCatalogService, "listCatalog">;
  /** Override the fallback model when no instance setting exists. */
  defaultModel?: string;
  /**
   * agent 治理五项的 **env 兜底**（DEC-18）：优先级 = 库值 ?? env ?? DEFAULTS。
   * 自托管/桌面打包场景不改库也能调档（如 `KENFUTWORK_SUBAGENT_MAX_CONCURRENCY=8`）。
   */
  governanceEnv?: AgentGovernanceOverrides;
  /**
   * 无实例设置时**动态解析**兜底模型（目录里首个可用的 chat 模型）。
   *
   * 为什么不能只用静态兜底：静态值来自 env（内置目录名，如 `gpt-4.1`），而实际可用模型
   * 由供应商实例决定——供应商只配了 GLM 时 `gpt-4.1` 在目录里根本不存在。不显式传 model
   * 的客户端（画布助手）会拿它起 run，上游直接拒绝：客户端只看到「处理过程中遇到问题」，
   * 服务端按可重试处理并重试满 10 次（实测 Design 模式面板整段不可用）。
   */
  resolveFallbackModel?: (actor: LocalActor) => Promise<string | undefined>;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;
  const governanceEnv = options.governanceEnv ?? {};
  const { repository } = options;
  const listeners = new Set<Parameters<SettingsService["onUpdated"]>[0]>();

  async function requireInstance(
    actor: LocalActor,
    instanceId: string,
  ): Promise<void> {
    if (actor.instanceId !== instanceId) {
      throw new SettingsServiceError(
        "settings_forbidden",
        "只能访问当前本地实例的设置。",
        403,
      );
    }
    await options.localInstance.resolve(actor);
  }

  const getCodeUiTransportSettings = async (
    actor: LocalActor,
    instanceId: string,
  ) => {
    await requireInstance(actor, instanceId);
    return {
      reconnectDelayMs: clampCodeUiReconnectDelayMs(
        (await repository.findCodeUiReconnectDelayMs(instanceId)) ??
          governanceEnv.codeUiReconnectDelayMs ??
          AGENT_GOVERNANCE_DEFAULTS.codeUiReconnectDelayMs,
      ),
    };
  };

  const getSettings = async (
    actor: LocalActor,
    instanceId: string,
  ): Promise<InstanceSettings> => {
    await requireInstance(actor, instanceId);
    const [
      storedModelDefaults,
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
      storedRuntimeGovernance,
    ] = await Promise.all([
      repository.findModelDefaults(instanceId),
      repository.findDefaultModel(instanceId),
      repository.findAgentMaxRetries(instanceId),
      repository.findTerminalShell(instanceId),
      repository.findCodeIndexEnabled(instanceId),
      repository.findCodeIndexAutoNewFolder(instanceId),
      repository.findAutoCompactEnabled(instanceId),
      repository.findUserRules(instanceId),
      repository.findCommands(instanceId),
      repository.findHooks(instanceId),
      repository.findSubagentMaxDepth(instanceId),
      repository.findSubagentMaxConcurrency(instanceId),
      repository.findSubagentMaxContinuations(instanceId),
      repository.findLlmRequestMaxRetries(instanceId),
      repository.findLlmInfiniteRetry(instanceId),
      repository.findExecuteTimeoutMs(instanceId),
      repository.findRuntimeGovernance(instanceId),
    ]).catch(() => {
      throw new SettingsServiceError(
        "settings_read_failed",
        "无法读取本地实例设置。",
        500,
      );
    });

    // 只在无库值时问目录：已显式设置过的实例不额外付一次目录读
    const resolvedFallback =
      storedModel === null
        ? await options.resolveFallbackModel?.(actor)
        : undefined;

    const runtimeValues =
      typeof storedRuntimeGovernance === "object" &&
      storedRuntimeGovernance !== null
        ? (storedRuntimeGovernance as Record<string, unknown>)
        : {};
    const runtimeGovernance = Object.fromEntries(
      RUNTIME_GOVERNANCE_KEYS.map((key) => [
        key,
        resolveGovernanceNumber(
          key,
          typeof runtimeValues[key] === "number"
            ? runtimeValues[key]
            : undefined,
          governanceEnv,
        ),
      ]),
    ) as Pick<InstanceSettings, RuntimeGovernanceKey>;

    return {
      modelDefaults: modelDefaultsSchema.parse(
        storedModelDefaults ?? {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
      ),
      ...runtimeGovernance,
      codeUiReconnectDelayMs: (
        await getCodeUiTransportSettings(actor, instanceId)
      ).reconnectDelayMs,
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
      // CU 治理五键（里程碑 1 无库列）：env 兜底 → DEFAULTS；表值列随 P2 落
      computerUseActionTimeoutMs: clampComputerUseActionTimeoutMs(
        governanceEnv.computerUseActionTimeoutMs ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
      ),
      computerUseObserveMaxBytes: clampComputerUseObserveMaxBytes(
        governanceEnv.computerUseObserveMaxBytes ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseObserveMaxBytes,
      ),
      computerUseScreenshotMaxBytes: clampComputerUseScreenshotMaxBytes(
        governanceEnv.computerUseScreenshotMaxBytes ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseScreenshotMaxBytes,
      ),
      computerUseMaxActionsPerRun: clampComputerUseMaxActionsPerRun(
        governanceEnv.computerUseMaxActionsPerRun ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseMaxActionsPerRun,
      ),
      computerUseSessionMaxMs: clampComputerUseSessionMaxMs(
        governanceEnv.computerUseSessionMaxMs ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
      ),
    };
  };

  return {
    onUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getCodeUiTransportSettings,
    getInstanceSettings: getSettings,

    async updateInstanceSettings(actor, instanceId, patch) {
      await requireInstance(actor, instanceId);
      if (patch.modelDefaults !== undefined) {
        if (!options.modelCatalog)
          throw new SettingsServiceError(
            "settings_update_failed",
            "模型目录服务不可用。",
            503,
          );
        const entries = await options.modelCatalog.listCatalog(actor);
        try {
          validateModelDefaults(
            modelDefaultsSchema.parse(patch.modelDefaults),
            entries,
          );
        } catch (error) {
          throw new SettingsServiceError(
            "invalid_model",
            error instanceof Error ? error.message : "所选模型不可用。",
            400,
          );
        }
      }
      await repository
        .atomicUpdate((writer) =>
          writeSettingsPatch({ writer, instanceId, patch }),
        )
        .catch(() => {
          throw new SettingsServiceError(
            "settings_update_failed",
            "无法更新本地实例设置。",
            500,
          );
        });

      // 回读真值：客户端拿到的是库里现在的事实，不是「我以为写成了什么」
      const result = await getSettings(actor, instanceId);
      const changedKeys = (
        Object.keys(patch) as Array<keyof InstanceSettingsPatch>
      ).filter((key) => patch[key] !== undefined);
      if (changedKeys.length) {
        const notified = await Promise.allSettled(
          [...listeners].map((listener) =>
            Promise.resolve().then(() =>
              listener({ instanceId, changedKeys: [...changedKeys] }),
            ),
          ),
        );
        for (const outcome of notified)
          if (outcome.status === "rejected")
            console.warn(
              "[settings] 设置事实已保存，配置消费者刷新失败：",
              outcome.reason,
            );
      }
      return result;
    },
  };
}
