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
>;
type NumericKey = Exclude<keyof AgentGovernanceSettings, "llmInfiniteRetry">;
export type AgentGovernanceInputs = Record<NumericKey, string>;

export const AGENT_GOVERNANCE_FIELDS = [
  {
    key: "subagentMaxDepth",
    label: "子代理派生深度",
    hint: "子代理可以再派生几层；1 = 不允许子代理派生子代理。",
  },
  {
    key: "subagentMaxConcurrency",
    label: "后台任务并发上限",
    hint: "同时运行的后台子代理 / 长命令数量上限。",
  },
  {
    key: "llmRequestMaxRetries",
    label: "模型请求重试次数",
    hint: "上游抖动时最多尝试几次（含首次），0 表示不重试。",
  },
  {
    key: "executeTimeoutMs",
    label: "命令超时（毫秒）",
    hint: "Code 模式后台命令的超时上限。",
  },
  {
    key: "agentStreamIdleTimeoutMs",
    label: "模型流无输出超时（毫秒）",
    hint: "仅计算真实模型请求的等待；工具执行和人工审批不计，0 表示关闭。",
  },
  {
    key: "subagentMaxContinuations",
    label: "后台任务等待轮数上限",
    hint: "收尾时若后台任务未结束，最多再等几轮。",
  },
  {
    key: "compactKeepMessages",
    label: "压缩保留目标（窗口已知）",
    hint: "模型上下文窗口已知时，希望保留的最近消息条数。",
  },
  {
    key: "compactFallbackKeepMessages",
    label: "压缩保留目标（窗口未知）",
    hint: "模型未声明上下文窗口且无法识别时使用的保留目标。",
  },
] as const satisfies readonly {
  key: NumericKey;
  label: string;
  hint: string;
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
