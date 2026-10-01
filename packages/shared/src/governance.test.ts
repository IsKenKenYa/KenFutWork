import { describe, expect, it } from "vitest";

import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampExecuteTimeoutMs,
  clampLlmRequestMaxRetries,
  clampSubagentMaxConcurrency,
  clampSubagentMaxDepth,
  resolveGovernanceEnvOverrides,
} from "./governance.js";

describe("agent 治理默认值与护栏（DEC-17/DEC-18）", () => {
  it("DEFAULTS 与用户拍板档一致", () => {
    expect(AGENT_GOVERNANCE_DEFAULTS).toEqual({
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
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
