import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import { createAgentRunService } from "./runtime.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";

/**
 * 取消要落终态（GUI 实测抓到的缺陷）。
 *
 * 用户在对话里点「停止本轮」时，`run.canceled` 能到客户端、流也停了
 * （服务端日志 `ws.run_cancel` → 38ms 后 `stream_done`），但 `agent_runs` 的行
 * **没有任何终态**——`syncPersistedRunFromEvent` 只认 `run.completed`/`run.failed`：
 *   1. 行永远停在 `running`（僵尸行），只能等下次进程启动的孤儿对账收敛成 `failed`；
 *   2. 用户主动取消被记成失败，失败率失真。
 *
 * 这里锁「取消路径写 status=canceled + completed_at」。
 */

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  };
}

/**
 * 一个「挂住不动」的 agent：只有本轮被取消（signal abort）时才结束。
 *
 * 必须**响应中止信号**而不是永远挂着：适配器收尾时会等底层生成器 `return()`，
 * 一个永不 settle 的生成器会把取消路径本身卡住（这也是这个测试要防的形态）。
 */
function makeHangingAgentFactory(): KenFutWorkAgentFactory {
  return (() =>
    ({
      streamEvents: async function* (
        _input: unknown,
        options?: { signal?: AbortSignal },
      ) {
        const signal = options?.signal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    }) as unknown as KenFutWorkAgent) as KenFutWorkAgentFactory;
}

function makeRuntime() {
  const updateRunCalls: Array<Record<string, unknown>> = [];
  const runtime = createAgentRunService({
    agentFactory: makeHangingAgentFactory(),
    blob: { upload: async () => ({}) } as never,
    env: makeEnv(),
    modelProviders: {
      getInstanceScope: async () => "workspace",
      resolveCredentials: async () => ({
        apiKey: "sk-test",
        protocol: "openai-compatible",
      }),
    } as never,
    viewerService: {
      resolveWorkspace: async () => ({ id: "ws-cancel-test" }),
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

describe("取消的终态落库（run.canceled）", () => {
  it("取消后写 status=canceled + completed_at，而不是停在 running", async () => {
    const { runtime, updateRunCalls } = makeRuntime();
    const { runId } = runtime.createRun(
      {
        canvasId: "conv-cancel-1",
        conversationId: "conv-cancel-1",
        prompt: "写点东西",
        sessionId: "sess-cancel-1",
      },
      {
        accessToken: "tok",
        model: "workspace-instance:test-model",
        threadId: "thread-cancel-1",
        userId: "u-cancel",
      },
    );

    const events: StreamEvent[] = [];
    const pump = (async () => {
      for await (const event of runtime.streamRun(runId)) {
        events.push(event);
      }
    })();

    // 等本轮真的跑起来（run.started 已出）再取消，避免取消信号打在创建之前
    for (let i = 0; i < 100 && !events.some((e) => e.type === "run.started"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((e) => e.type === "run.started")).toBe(true);

    expect(runtime.cancelRun(runId)).not.toBeNull();
    await pump;

    expect(events.at(-1)?.type).toBe("run.canceled");
    expect(updateRunCalls.at(-1)).toMatchObject({
      runId,
      status: "canceled",
    });
    expect(updateRunCalls.at(-1)?.completedAt).toBeTruthy();
  });
});
