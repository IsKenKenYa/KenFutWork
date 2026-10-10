import { describe, expect, it } from "vitest";
import { instanceSettingsSchema } from "./contracts.js";

import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampExecuteTimeoutMs,
  clampLlmRequestMaxRetries,
  clampSubagentMaxConcurrency,
  clampSubagentMaxDepth,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";

describe("agent 治理默认值与护栏（DEC-17/DEC-18）", () => {
  it("模型无输出计时支持显式0关闭、库优先与严格env解析，非法值不关闭保护", () => {
    expect(
      instanceSettingsSchema.parse({ defaultModel: "fixture" })
        .agentStreamIdleTimeoutMs,
    ).toBe(180_000);
    expect(
      resolveGovernanceEnvOverrides({
        KENFUTWORK_AGENT_STREAM_IDLE_TIMEOUT_MS: "0",
      }),
    ).toEqual({ agentStreamIdleTimeoutMs: 0 });
    for (const value of ["-1", "abc", "250ms", "1.5", ""]) {
      expect(
        resolveGovernanceEnvOverrides({
          KENFUTWORK_AGENT_STREAM_IDLE_TIMEOUT_MS: value,
        }),
      ).toEqual({});
    }
    expect(
      resolveGovernanceNumber("agentStreamIdleTimeoutMs", 0, {
        agentStreamIdleTimeoutMs: 500,
      }),
    ).toBe(0);
    expect(
      resolveGovernanceNumber("agentStreamIdleTimeoutMs", undefined, {
        agentStreamIdleTimeoutMs: 500,
      }),
    ).toBe(500);
    expect(
      instanceSettingsSchema.safeParse({
        defaultModel: "fixture",
        agentStreamIdleTimeoutMs: -1,
      }).success,
    ).toBe(false);
  });
  it("DEFAULTS 与用户拍板档一致", () => {
    expect(AGENT_GOVERNANCE_DEFAULTS).toMatchObject({
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      codeUiReconnectDelayMs: 1000,
      subagentMaxContinuations: 50,
      // Computer Use 五项（CU 插件里程碑 1 拍板档）
      computerUseActionTimeoutMs: 10_000,
      computerUseObserveMaxBytes: 32_768,
      computerUseScreenshotMaxBytes: 262_144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1_800_000,
    });
  });

  it("clamp 把越界值钳回护栏，非法输入落区间下限", () => {
    expect(clampSubagentMaxDepth(2)).toBe(2);
    expect(clampSubagentMaxDepth(99)).toBe(4);
    expect(clampSubagentMaxDepth(-3)).toBe(1);
    expect(clampSubagentMaxDepth(Number.NaN)).toBe(1);
    expect(clampSubagentMaxDepth(1.9)).toBe(1);

    expect(clampSubagentMaxConcurrency(0)).toBe(1);
    expect(clampSubagentMaxConcurrency(16)).toBe(16);
    expect(clampSubagentMaxConcurrency(17)).toBe(16);

    expect(clampLlmRequestMaxRetries(0)).toBe(0);
    expect(clampLlmRequestMaxRetries(101)).toBe(100);

    expect(clampExecuteTimeoutMs(1)).toBe(5000);
    expect(clampExecuteTimeoutMs(1_800_000)).toBe(1_800_000);
    expect(clampExecuteTimeoutMs(Number.POSITIVE_INFINITY)).toBe(5000);
  });

  it("env 兜底：合法值解析、非法值忽略（不抛错不编值）", () => {
    expect(
      resolveGovernanceEnvOverrides({
        KENFUTWORK_SUBAGENT_MAX_DEPTH: "2",
        KENFUTWORK_SUBAGENT_MAX_CONCURRENCY: "8",
        KENFUTWORK_LLM_REQUEST_MAX_RETRIES: "0",
        KENFUTWORK_LLM_INFINITE_RETRY: "true",
        KENFUTWORK_EXECUTE_TIMEOUT_MS: "600000",
        KENFUTWORK_SUBAGENT_MAX_CONTINUATIONS: "10",
      }),
    ).toEqual({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 8,
      llmRequestMaxRetries: 0,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
      subagentMaxContinuations: 10,
    });

    expect(
      resolveGovernanceEnvOverrides({
        KENFUTWORK_SUBAGENT_MAX_DEPTH: "abc",
        KENFUTWORK_LLM_INFINITE_RETRY: "yes",
        KENFUTWORK_EXECUTE_TIMEOUT_MS: "",
      }),
    ).toEqual({ llmInfiniteRetry: true });

    expect(resolveGovernanceEnvOverrides({})).toEqual({});
  });
});
