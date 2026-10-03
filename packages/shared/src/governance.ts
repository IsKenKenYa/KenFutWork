import { z } from "zod";

/**
 * agent 治理可调数值的唯一默认值/护栏属主（DEC-17/DEC-18，用户拍板：桌面 BYOK，
 * key 不是我们提供的，一切限额必须用户可调）。
 *
 * 口径（AGENTS.md「运行时 tunables」硬约束）：一切运行时可调数值，代码里只允许
 * 出现这里的 DEFAULTS 与区间护栏（shared 的 `workspaceSettingsSchema` 直接引用
 * 本模块常量，禁止另写一份字面量）；覆盖入口只有两个——`workspace_settings` 表
 * （设置页）与 env 兜底（`resolveGovernanceEnvOverrides`）。表里的越界值
 * （手改/旧数据）在读侧钳回护栏，不报错也不放行。
 */

export const AGENT_GOVERNANCE_DEFAULTS = {
  /** 子代理派生深度上限：1 = 子代理不得再派生（禁孙代理）。 */
  subagentMaxDepth: 1,
  /** 后台任务（子代理/长命令）同时运行上限。 */
  subagentMaxConcurrency: 4,
  /** 轮末闸门续轮上限：防挂死后台任务导致无限续轮（DEC-15/18）。 */
  subagentMaxContinuations: 50,
  /** LLM 请求级重试上限（含首次；0 = 不重试）。 */
  llmRequestMaxRetries: 10,
  /** LLM 请求无限重试（用户显式开启，治持续 429 的不稳定上游）。 */
  llmInfiniteRetry: false,
  /** Code 模式 execute 命令超时（毫秒）。 */
  executeTimeoutMs: 120_000,
  /** Code 宿主通知通道断线后的重连间隔（毫秒）。 */
  codeUiReconnectDelayMs: 1_000,
  /** Computer Use：单个桌面动作（点击/输入/截屏）超时（毫秒）。 */
  computerUseActionTimeoutMs: 10_000,
  /** Computer Use：观察树文本预算（字节），超限按优先级裁剪。 */
  computerUseObserveMaxBytes: 32_768,
  /** Computer Use：截图内联 base64 预算（字节），超限只回文字摘要。 */
  computerUseScreenshotMaxBytes: 262_144,
  /** Computer Use：单个 run 内动作数上限（防失控连点）。 */
  computerUseMaxActionsPerRun: 200,
  /** Computer Use：控制租约会话时长上限（毫秒）。 */
  computerUseSessionMaxMs: 1_800_000,
} as const;

export type AgentGovernanceValue = keyof typeof AGENT_GOVERNANCE_DEFAULTS;

/** 覆盖值形态（env / 调用方传参）：键可缺、值可显式 undefined（exactOptionalPropertyTypes）。 */
export type AgentGovernanceOverrides = {
  subagentMaxDepth?: number | undefined;
  subagentMaxConcurrency?: number | undefined;
  llmRequestMaxRetries?: number | undefined;
  llmInfiniteRetry?: boolean | undefined;
  executeTimeoutMs?: number | undefined;
  codeUiReconnectDelayMs?: number | undefined;
  subagentMaxContinuations?: number | undefined;
  computerUseActionTimeoutMs?: number | undefined;
  computerUseObserveMaxBytes?: number | undefined;
  computerUseScreenshotMaxBytes?: number | undefined;
  computerUseMaxActionsPerRun?: number | undefined;
  computerUseSessionMaxMs?: number | undefined;
};

const clampInt = (value: number, min: number, max: number): number =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : min;

export const clampSubagentMaxDepth = (value: number): number =>
  clampInt(value, 1, 4);

export const clampSubagentMaxConcurrency = (value: number): number =>
  clampInt(value, 1, 16);

export const clampSubagentMaxContinuations = (value: number): number =>
  clampInt(value, 1, 200);

export const clampLlmRequestMaxRetries = (value: number): number =>
  clampInt(value, 0, 100);

export const clampExecuteTimeoutMs = (value: number): number =>
  clampInt(value, 5_000, 1_800_000);

export const clampCodeUiReconnectDelayMs = (value: number): number =>
  clampInt(
    value,
    AGENT_GOVERNANCE_LIMITS.codeUiReconnectDelayMs.min,
    AGENT_GOVERNANCE_LIMITS.codeUiReconnectDelayMs.max,
  );

export const clampComputerUseActionTimeoutMs = (value: number): number =>
  clampInt(value, 1_000, 120_000);

export const clampComputerUseObserveMaxBytes = (value: number): number =>
  clampInt(value, 4_096, 262_144);

export const clampComputerUseScreenshotMaxBytes = (value: number): number =>
  clampInt(value, 16_384, 2_097_152);

export const clampComputerUseMaxActionsPerRun = (value: number): number =>
  clampInt(value, 1, 2_000);

export const clampComputerUseSessionMaxMs = (value: number): number =>
  clampInt(value, 60_000, 86_400_000);

export const coerceLlmInfiniteRetry = (value: unknown): boolean =>
  value === true;

/** 供 `workspaceSettingsSchema` 直接引用的区间护栏（与 clamp 同区间）。 */
export const AGENT_GOVERNANCE_LIMITS = {
  subagentMaxDepth: { min: 1, max: 4 },
  subagentMaxConcurrency: { min: 1, max: 16 },
  llmRequestMaxRetries: { min: 0, max: 100 },
  executeTimeoutMs: { min: 5_000, max: 1_800_000 },
  codeUiReconnectDelayMs: { min: 100, max: 60_000 },
  subagentMaxContinuations: { min: 1, max: 200 },
  computerUseActionTimeoutMs: { min: 1_000, max: 120_000 },
  computerUseObserveMaxBytes: { min: 4_096, max: 262_144 },
  computerUseScreenshotMaxBytes: { min: 16_384, max: 2_097_152 },
  computerUseMaxActionsPerRun: { min: 1, max: 2_000 },
  computerUseSessionMaxMs: { min: 60_000, max: 86_400_000 },
} as const;

/**
 * env 兜底解析：`KENFUTWORK_<大写字段名>`。数值只认可整数字符串；布尔认
 * `true/1/yes/on` 与 `false/0/no/off`（对齐 kimi `KIMI_CODE_INFINITE_RETRY` 口径）。
 * 非法值**忽略**（不抛错、不编值）——env 是兜底不是接口，写错了落表值/默认值。
 * 只输出有定义的键：调用方的 `??` 链与「有无覆盖」判定都不必滤 undefined。
 */
export function resolveGovernanceEnvOverrides(
  source: Record<string, string | undefined>,
): AgentGovernanceOverrides {
  const parseStrictInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  };
  const truthy = new Set(["true", "1", "yes", "on"]);
  const falsy = new Set(["false", "0", "no", "off"]);
  const parseBool = (raw: string | undefined): boolean | undefined => {
    if (raw === undefined) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (truthy.has(normalized)) return true;
    if (falsy.has(normalized)) return false;
    return undefined;
  };

  const overrides: AgentGovernanceOverrides = {
    subagentMaxDepth: parseStrictInt(source.KENFUTWORK_SUBAGENT_MAX_DEPTH),
    subagentMaxConcurrency: parseStrictInt(
      source.KENFUTWORK_SUBAGENT_MAX_CONCURRENCY,
    ),
    llmRequestMaxRetries: parseStrictInt(
      source.KENFUTWORK_LLM_REQUEST_MAX_RETRIES,
    ),
    llmInfiniteRetry: parseBool(source.KENFUTWORK_LLM_INFINITE_RETRY),
    executeTimeoutMs: parseStrictInt(source.KENFUTWORK_EXECUTE_TIMEOUT_MS),
    codeUiReconnectDelayMs: parseStrictInt(
      source.KENFUTWORK_CODE_UI_RECONNECT_DELAY_MS,
    ),
    subagentMaxContinuations: parseStrictInt(
      source.KENFUTWORK_SUBAGENT_MAX_CONTINUATIONS,
    ),
    computerUseActionTimeoutMs: parseStrictInt(
      source.KENFUTWORK_COMPUTER_USE_ACTION_TIMEOUT_MS,
    ),
    computerUseObserveMaxBytes: parseStrictInt(
      source.KENFUTWORK_COMPUTER_USE_OBSERVE_MAX_BYTES,
    ),
    computerUseScreenshotMaxBytes: parseStrictInt(
      source.KENFUTWORK_COMPUTER_USE_SCREENSHOT_MAX_BYTES,
    ),
    computerUseMaxActionsPerRun: parseStrictInt(
      source.KENFUTWORK_COMPUTER_USE_MAX_ACTIONS_PER_RUN,
    ),
    computerUseSessionMaxMs: parseStrictInt(
      source.KENFUTWORK_COMPUTER_USE_SESSION_MAX_MS,
    ),
  };
  return Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as AgentGovernanceOverrides;
}

/**
 * 治理字段在设置响应里的解析档：DEFAULTS 打底 + 区间护栏。
 * `workspaceSettingsSchema` 的五个字段全部经此构造，禁止手写第二份字面量。
 */
export function governanceSetting<
  K extends
    | "subagentMaxDepth"
    | "subagentMaxConcurrency"
    | "llmRequestMaxRetries"
    | "executeTimeoutMs"
    | "codeUiReconnectDelayMs"
    | "subagentMaxContinuations"
    | "computerUseActionTimeoutMs"
    | "computerUseObserveMaxBytes"
    | "computerUseScreenshotMaxBytes"
    | "computerUseMaxActionsPerRun"
    | "computerUseSessionMaxMs",
>(key: K) {
  const limits = AGENT_GOVERNANCE_LIMITS[key];
  return z
    .number()
    .int()
    .min(limits.min)
    .max(limits.max)
    .default(AGENT_GOVERNANCE_DEFAULTS[key]);
}

export function governanceBoolSetting<K extends "llmInfiniteRetry">(key: K) {
  return z.boolean().default(AGENT_GOVERNANCE_DEFAULTS[key]);
}
