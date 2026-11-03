import {
  AGENT_GOVERNANCE_LIMITS,
  type InstanceSettings,
} from "@kenfutwork/shared";

export type AgentGovernanceSettings = Pick<
  InstanceSettings,
  | "subagentMaxDepth"
  | "subagentMaxConcurrency"
  | "llmRequestMaxRetries"
  | "llmInfiniteRetry"
  | "executeTimeoutMs"
  | "agentStreamIdleTimeoutMs"
  | "subagentMaxContinuations"
  | "compactKeepMessages"
  | "compactFallbackKeepMessages"
  | "contextKeepRecentImages"
  | "toolResultOffloadMaxChars"
  | "toolResultOffloadMaxBytes"
  | "toolResultPruneThresholdChars"
  | "toolResultPruneKeepRecent"
  | "memoryOrphanRetentionDays"
  | "memoryRecoverableWindowDays"
  | "memoryMaintenanceIntervalMs"
  | "canvasExportMaxBytes"
  | "taskAutoArchiveScanIntervalMs"
  | "pluginCardMaxFields"
  | "pluginCardFieldValueMaxChars"
>;
type NumericKey = Exclude<keyof AgentGovernanceSettings, "llmInfiniteRetry">;
export type AgentGovernanceInputs = Record<NumericKey, string>;

export const AGENT_GOVERNANCE_FIELDS = [
  {
    key: "subagentMaxDepth",
    label: "子代理派生深度",
  },
  {
    key: "subagentMaxConcurrency",
    label: "后台任务并发上限",
  },
  {
    key: "llmRequestMaxRetries",
    label: "模型请求重试次数",
  },
  {
    key: "executeTimeoutMs",
    label: "命令超时（毫秒）",
  },
  {
    key: "agentStreamIdleTimeoutMs",
    label: "模型流无输出超时（毫秒）",
  },
  {
    key: "subagentMaxContinuations",
    label: "后台任务等待轮数上限",
  },
  {
    key: "compactKeepMessages",
    label: "压缩保留目标（窗口已知）",
  },
  {
    key: "compactFallbackKeepMessages",
    label: "压缩保留目标（窗口未知）",
  },
  {
    key: "contextKeepRecentImages",
    label: "保留最近图片张数",
  },
  {
    key: "toolResultOffloadMaxChars",
    label: "工具结果外置阈值（字符）",
  },
  {
    key: "toolResultOffloadMaxBytes",
    label: "外置文件上限（字节）",
  },
  {
    key: "toolResultPruneThresholdChars",
    label: "旧工具结果折叠阈值（字符）",
  },
  {
    key: "toolResultPruneKeepRecent",
    label: "保留原文的最近工具结果条数",
  },
  {
    key: "memoryOrphanRetentionDays",
    label: "记忆闲置回收天数",
  },
  {
    key: "memoryRecoverableWindowDays",
    label: "回收区保留天数",
  },
  {
    key: "memoryMaintenanceIntervalMs",
    label: "记忆整理间隔（毫秒）",
  },
  {
    key: "canvasExportMaxBytes",
    label: "画布导出上限（字节）",
  },
  {
    key: "taskAutoArchiveScanIntervalMs",
    label: "归档扫描间隔（毫秒）",
  },
  {
    key: "pluginCardMaxFields",
    label: "插件卡片键值行数上限",
  },
  {
    key: "pluginCardFieldValueMaxChars",
    label: "插件卡片值长度上限",
  },
] as const satisfies readonly {
  key: NumericKey;
  label: string;
}[];

function validNumber(key: NumericKey, value: number) {
  const { min, max } = AGENT_GOVERNANCE_LIMITS[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

/** 只选择真实响应的治理值，不把未返回的字段补成本地默认。 */
export function selectAgentGovernanceSettings(
  settings: InstanceSettings,
): AgentGovernanceSettings {
  if (
    !settings ||
    typeof settings.llmInfiniteRetry !== "boolean" ||
    !AGENT_GOVERNANCE_FIELDS.every(({ key }) => validNumber(key, settings[key]))
  )
    throw new Error("实例治理设置响应不完整，请重新加载。");
  return {
    ...Object.fromEntries(
      AGENT_GOVERNANCE_FIELDS.map(({ key }) => [key, settings[key]]),
    ),
    llmInfiniteRetry: settings.llmInfiniteRetry,
  } as AgentGovernanceSettings;
}

export function governanceInputValues(
  settings: AgentGovernanceSettings,
): AgentGovernanceInputs {
  return Object.fromEntries(
    AGENT_GOVERNANCE_FIELDS.map(({ key }) => [key, String(settings[key])]),
  ) as AgentGovernanceInputs;
}

export function parseAgentGovernanceInputs(
  inputs: AgentGovernanceInputs,
  llmInfiniteRetry: boolean,
): AgentGovernanceSettings | null {
  const numbers = Object.fromEntries(
    AGENT_GOVERNANCE_FIELDS.map(({ key }) => [
      key,
      inputs[key].trim() ? Number(inputs[key]) : Number.NaN,
    ]),
  ) as Record<NumericKey, number>;
  if (
    !AGENT_GOVERNANCE_FIELDS.every(({ key }) => validNumber(key, numbers[key]))
  )
    return null;
  return { ...numbers, llmInfiniteRetry };
}
