import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import { createAgentRunService } from "./runtime.js";
import type { StreamEvent } from "@loomic/shared";

/**
 * 额度门回归（GUI 实测复现的事故）：
 * 平台池余额为 0 时，run 在模型解析阶段被 billing 门中止。历史上该路径
 * 在生成器里**静默 return**——零事件结束导致两个连锁问题：
 * 1. agent_runs 行永远停在 running（无终态写入）；
 * 2. WS 重试判定拿不到失败文案（undefined 视为可重试），额度不足这类
 *    永久性失败被连环重试 10 次、秒开 10 个 run 行。
 * 修复后必须补发 run.failed（文案含「额度」，命中永久性失败模式）。
 */

const INSTANCE_ID = "73270d3f-fbef-4ae3-ae13-645862e7fc62";

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  };
}

function makeBillingBlockedRuntime() {
  const updateRunCalls: Array<Record<string, unknown>> = [];
  const agentFactory = () => {
    throw new Error("billing 门应在 agent 创建前拦截，工厂不该被调用");
  };
  const runtime = createAgentRunService({
    agentFactory,
    blob: {
      upload: async () => {
        throw new Error("unused");
      },
    } as never,
    creditService: {
      getBalance: async () => ({
        balance: 0,
        plan: "pro",
        dailyClaimed: false,
      }),
    } as never,
    env: makeEnv(),
    modelProviders: {
      getInstanceScope: async () => "system",
      resolveCredentials: async () => ({
        apiKey: "test-key",
        protocol: "openai-compatible",
      }),
    } as never,
    viewerService: {
      resolveWorkspace: async () => ({ id: "ws-billing-test" }),
    } as never,
    agentPersistenceService: {
      getPersistence: async () => ({ checkpointer: null, store: null }),
    } as never,
    agentRunMetadataService: {
      updateRun: async (input: Record<string, unknown>) => {
        updateRunCalls.push(input);
      },
    } as never,
  });
  return { runtime, updateRunCalls };
}

async function drainRun(stream: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("平台池额度门（FORM-10）", () => {
  it("余额为 0：补发 run.failed（含额度文案）并写失败终态，不再静默结束", async () => {
    const { runtime, updateRunCalls } = makeBillingBlockedRuntime();
    const { runId } = runtime.createRun(
      {
        canvasId: "conv-billing-1",
        conversationId: "conv-billing-1",
        prompt: "帮我写个脚本",
        sessionId: "sess-billing-1",
      },
      {
        accessToken: "tok",
        model: `${INSTANCE_ID}:glm-test`,
        threadId: "thread-billing-1",
        userId: "u-billing",
      },
    );
    const events = await drainRun(runtime.streamRun(runId));

    // 恰好一个事件：run.failed，文案可读且命中永久性失败关键词
    expect(events).toHaveLength(1);
    const failed = events[0];
    expect(failed?.type).toBe("run.failed");
    if (failed?.type !== "run.failed") throw new Error("unreachable");
    expect(failed.error.message).toContain("额度");
    expect(failed.error.code).toBe("run_failed");

    // 终态落库：status=failed（而非停在 running）
    expect(updateRunCalls.at(-1)).toMatchObject({
      runId,
      status: "failed",
    });
  });
});
