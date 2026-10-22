import type { OpenDesignHostCredentialEntry } from "@kenfutwork/shared";

/**
 * OpenDesign 自动配置（免登录 + BYOK 注入）。
 *
 * 上游 daemon 的 `/onboarding` 之所以挡登录·注册，是因为 `app-config.json` 里
 * 没有 `onboardingCompleted` 且 `agentId` 为空，而它把「OpenDesign Cloud 账号」当成
 * 唯一可用路径。本模块只写上游自己声明接受的键（`ALLOWED_KEYS`），不改上游源码。
 *
 * BYOK 的落点也是上游给的：`agentCliEnv[agentId]` 只接受白名单内的环境变量，且
 * **只有 claude 与 codex 两类接受 key + base URL**，其余 agent 只接受 `*_BIN`。
 * 所以「用我们配好的 AI」成立的前提是容器里真有对应 CLI——没有时本模块只完成
 * onboarding，并把原因如实带回（不假装配好了）。
 *
 * 凭据边界（DEC-7，用户 2026-10-19 明确批准）：API Key 会写进 OpenDesign 自己
 * 持久化的 `agentCliEnv`（容器卷内 `app-config.json`，本机明文）。因此这里
 * **任何日志与返回结构都不带 Key 值**，只带 agentId 与可读原因。
 */

/** 我方 BYOK 协议 → 上游 agent 与其接受的两个环境变量。 */
const PROTOCOL_TO_AGENT: Record<
  string,
  { agentId: string; apiKeyEnv: string; baseUrlEnv: string }
> = {
  anthropic: {
    agentId: "claude",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  "openai-compatible": {
    agentId: "codex",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
};

export interface OpenDesignAgentSummary {
  id: string;
  available: boolean;
}

export type OpenDesignProvisionPlan = {
  /** 要写进 `PUT /api/app-config` 的补丁（扁平 body，上游按 ALLOWED_KEYS 过滤）。 */
  patch: Record<string, unknown>;
  /** 选定的 agent；没有可用 CLI 时为 null。 */
  agentId: string | null;
  /** 未注入 BYOK 的可读原因（不含 Key）。 */
  reason: string | null;
};

/**
 * 计算补丁：onboarding 一律完成；能匹配到「可用 agent + 有 Key 的实例」才注入 CLI 环境。
 * 只输出与现值不同的键，避免每次启动都重写一遍含 Key 的配置。
 */
export function buildOpenDesignProvisionPlan(input: {
  entries: OpenDesignHostCredentialEntry[];
  agents: OpenDesignAgentSummary[];
  current: Record<string, unknown>;
}): OpenDesignProvisionPlan {
  const patch: Record<string, unknown> = {};
  if (input.current.onboardingCompleted !== true) {
    patch.onboardingCompleted = true;
  }
  const available = new Set(
    input.agents.filter((agent) => agent.available).map((agent) => agent.id),
  );
  for (const entry of input.entries) {
    const mapping = PROTOCOL_TO_AGENT[entry.protocol];
    if (!mapping) continue;
    if (!available.has(mapping.agentId)) continue;
    if (!entry.apiKey) continue;
    // 合并而不是整体替换：`CODEX_BIN`/`CODEX_HOME` 这类由操作者预置的 CLI 环境
    // 不属于本供给流程，整对象覆盖会在每次宿主重启时把它抹掉（实测踩过）。
    const currentAgentCliEnv = isRecord(input.current.agentCliEnv)
      ? input.current.agentCliEnv
      : {};
    const existingEnv = isRecord(currentAgentCliEnv[mapping.agentId])
      ? (currentAgentCliEnv[mapping.agentId] as Record<string, unknown>)
      : {};
    const env: Record<string, string> = {
      ...(existingEnv as Record<string, string>),
      [mapping.apiKeyEnv]: entry.apiKey,
    };
    if (entry.apiBase) env[mapping.baseUrlEnv] = entry.apiBase;
    patch.agentCliEnv = {
      ...currentAgentCliEnv,
      [mapping.agentId]: env,
    };
    patch.agentId = mapping.agentId;
    return { patch, agentId: mapping.agentId, reason: null };
  }
  const reason =
    input.entries.length === 0
      ? "没有已配置 API Key 的供应商实例，OpenDesign 只完成引导，模型仍需自行选择。"
      : "容器内没有任何可用的 coding-agent CLI（/api/agents 全部 available=false），OpenDesign 只完成引导。";
  return { patch, agentId: null, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 执行一次自动配置。失败只返回原因，不抛——伴随容器已经起来了，
 * 配置没写进去不该让整个宿主装配失败。
 */
export async function provisionOpenDesign(input: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  entries: OpenDesignHostCredentialEntry[];
  log?: (message: string) => void;
}): Promise<{ done: boolean; agentId: string | null; reason: string | null }> {
  const base = input.baseUrl.replace(/\/+$/, "");
  try {
    const [agentsResponse, configResponse] = await Promise.all([
      input.fetchImpl(`${base}/api/agents`),
      input.fetchImpl(`${base}/api/app-config`),
    ]);
    if (!agentsResponse.ok || !configResponse.ok) {
      return {
        done: false,
        agentId: null,
        reason: `OpenDesign 配置接口未就绪（agents ${agentsResponse.status} / config ${configResponse.status}）。`,
      };
    }
    const agentsPayload = (await agentsResponse.json()) as unknown;
    const configPayload = (await configResponse.json()) as unknown;
    const agents = normalizeAgents(agentsPayload);
    const current =
      isRecord(configPayload) && isRecord(configPayload.config)
        ? configPayload.config
        : {};
    const plan = buildOpenDesignProvisionPlan({
      entries: input.entries,
      agents,
      current,
    });
    if (Object.keys(plan.patch).length === 0) {
      return { done: true, agentId: plan.agentId, reason: plan.reason };
    }
    const written = await input.fetchImpl(`${base}/api/app-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.patch),
    });
    if (!written.ok) {
      return {
        done: false,
        agentId: plan.agentId,
        reason: `OpenDesign 配置写入被拒（HTTP ${written.status}）。`,
      };
    }
    if (plan.reason) input.log?.(`[open-design] ${plan.reason}`);
    return { done: true, agentId: plan.agentId, reason: plan.reason };
  } catch (error) {
    return {
      done: false,
      agentId: null,
      reason: `OpenDesign 自动配置异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizeAgents(payload: unknown): OpenDesignAgentSummary[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.agents)
      ? payload.agents
      : [];
  return list
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => typeof item.id === "string")
    .map((item) => ({
      id: item.id as string,
      available: item.available === true,
    }));
}
