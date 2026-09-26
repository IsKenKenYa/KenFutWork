import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import type { BackgroundTaskRegistry } from "./background-tasks.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";

/**
 * 轮末闸门（continuation 循环，`DEC-15`）的行为测试——接缝④。
 *
 * 语义：模型收尾（run.completed）时若后台任务未结算，runtime 吞掉这次终态、
 * 把结算通知作为新一轮输入重入同一 thread，直到全部结算才放行终态。
 * 用 fake 子代理 promise 三态锁死：**先结算后收尾 / 收尾时仍挂起 / 取消**。
 *
 * fake agent 经真实 streamRun 全链驱动（与 runtime-cancel-persistence 测试同一
 * harness 形态）；注册表从工厂 options 里拿（与真实装配同一条注入路径）。
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

type Round = { inputText: string };

/**
 * fake agent：每轮记录收到的最后一 条消息文本；轮内行为由脚本驱动。
 * `onRound` 在每轮开始时拿到注册表（真实派发就在这一步发生）。
 */
function makeScriptedFactory(
  onRound: (ctx: {
    registry: BackgroundTaskRegistry;
    round: number;
    lastInputText: string;
  }) => void,
): {
  agentFactory: KenFutWorkAgentFactory;
  rounds: Round[];
} {
  const rounds: Round[] = [];
  const agentFactory: KenFutWorkAgentFactory = (options) => {
    return {
      streamEvents: async function* (input: unknown) {
        const registry = (
          options as {
            backgroundTasks?: { registry: BackgroundTaskRegistry };
          }
        ).backgroundTasks?.registry;
        const messages =
          (input as { messages?: Array<unknown> }).messages ?? [];
        const last = messages.at(-1) as
          | { content?: unknown; text?: string }
          | undefined;
        const lastInputText =
          typeof last?.content === "string"
            ? last.content
            : typeof last?.text === "string"
              ? last.text
              : "";
        rounds.push({ inputText: lastInputText });
        if (registry)
          onRound({ registry, round: rounds.length, lastInputText });
        // 正常收尾：适配器在流自然结束时发 run.completed。
        //（占位 yield：让本函数成为合法生成器；适配器忽略未知事件。）
        yield { event: "__test_noop__" };
      },
    } as unknown as KenFutWorkAgent;
  };
  return { agentFactory, rounds };
}

function makeRuntime(agentFactory: KenFutWorkAgentFactory) {
  return createAgentRunService({
    agentFactory,
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
      resolveWorkspace: async () => ({ id: "ws-continuation-test" }),
    } as never,
    agentPersistenceService: {
      getPersistence: async () => ({ checkpointer: null, store: null }),
    } as never,
    agentRunMetadataService: {
      updateRun: async () => {},
    } as never,
  });
}

function makeRun(runtime: ReturnType<typeof createAgentRunService>) {
  const { runId } = runtime.createRun(
    {
      canvasId: "conv-cont-1",
      conversationId: "conv-cont-1",
      prompt: "派个后台任务",
      sessionId: "sess-cont-1",
    },
    {
      accessToken: "tok",
      model: "workspace-instance:test-model",
      threadId: "thread-cont-1",
      userId: "u-cont",
    },
  );
  return runId;
}

async function pump(
  runtime: ReturnType<typeof createAgentRunService>,
  runId: string,
) {
  const events: StreamEvent[] = [];
  for await (const event of runtime.streamRun(runId)) {
    events.push(event);
  }
  return events;
}

describe("轮末闸门：run 等待后台任务结算（DEC-15）", () => {
  it("收尾时仍挂起：吞掉 completed → 通知重入 → 全结算后才放行终态", async () => {
    const { agentFactory, rounds } = makeScriptedFactory(
      ({ registry, round }) => {
        if (round === 1) {
          // 第一轮：模型派了后台任务（保持 pending）然后收尾
          registry.register({ kind: "subagent", label: "explore · 调研" });
        }
        if (round === 2) {
          // 第二轮开始时后台任务已由外部结算（通知等待注入）
          registry.settle(registry.list()[0]?.taskId ?? "missing", {
            status: "completed",
            summary: "调研完成",
          });
        }
      },
    );
    const runtime = makeRuntime(agentFactory);
    const runId = makeRun(runtime);
    const events = await pump(runtime, runId);

    // 两轮调用：第一轮被吞、第二轮放行
    expect(rounds).toHaveLength(2);
    // 第二轮输入是 <task-notifications> 包裹的通知消息（mailbox 形态）
    expect(rounds[1]?.inputText).toContain("<task-notifications>");
    // 终态只有一次，且事件流里确实放行了 run.completed
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
    // 结算通知以 task.notification 事件到达前端（同一份事实）
    const notifications = events.filter((e) => e.type === "task.notification");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "task.notification",
      kind: "subagent",
      status: "completed",
      summary: "调研完成",
    });
  });

  it("先结算后收尾：无挂起任务则不续轮，一次 completed 直达", async () => {
    const { agentFactory, rounds } = makeScriptedFactory(({ registry }) => {
      const registered = registry.register({
        kind: "command",
        label: "pnpm build",
      });
      // 派完立即结算（快任务在模型收尾前已结束）
      if (registered.ok) {
        registry.settle(registered.taskId, {
          status: "completed",
          summary: "build ok",
        });
      }
    });
    const runtime = makeRuntime(agentFactory);
    const runId = makeRun(runtime);
    const events = await pump(runtime, runId);

    expect(rounds).toHaveLength(1);
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("取消：模型流挂着 + 后台任务挂着，cancelRun 后以 run.canceled 收尾（不续轮）", async () => {
    const abortSpies: string[] = [];
    const rounds: number[] = [];
    const agentFactory: KenFutWorkAgentFactory = (options) => {
      return {
        streamEvents: async function* (
          _input: unknown,
          genOptions?: { signal?: AbortSignal },
        ) {
          rounds.push(rounds.length + 1);
          const registry = (
            options as {
              backgroundTasks?: { registry: BackgroundTaskRegistry };
            }
          ).backgroundTasks?.registry;
          if (rounds.length === 1 && registry) {
            const registered = registry.register({
              kind: "subagent",
              label: "explore · 长调研",
              abort: () => abortSpies.push("abort"),
            });
            if (!registered.ok) throw new Error("unreachable");
          }
          const signal = genOptions?.signal;
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      } as unknown as KenFutWorkAgent;
    };
    const runtime = makeRuntime(agentFactory);
    const runId = makeRun(runtime);

    const events: StreamEvent[] = [];
    const pumpPromise = (async () => {
      for await (const event of runtime.streamRun(runId)) {
        events.push(event);
      }
    })();
    for (
      let i = 0;
      i < 100 && !events.some((e) => e.type === "run.started");
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.cancelRun(runId)).not.toBeNull();
    await pumpPromise;

    // 取消路径：不触发续轮、终态是 run.canceled
    expect(rounds).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.canceled");
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(0);
  });
});

describe("轮末闸门上限：挂死后台任务不产生无限续轮（DEC-18）", () => {
  it("续轮打到治理上限后放行终态，残留任务被 abortAll 收割并发取消通知", async () => {
    let rounds = 0;
    let capturedRegistry: BackgroundTaskRegistry | undefined;
    const agentFactory: KenFutWorkAgentFactory = (options) => {
      capturedRegistry = (
        options as { backgroundTasks?: { registry: BackgroundTaskRegistry } }
      ).backgroundTasks?.registry;
      return {
        streamEvents: async function* () {
          rounds += 1;
          if (rounds === 1 && capturedRegistry) {
            capturedRegistry.register({
              kind: "command",
              label: "挂死的构建命令",
              abort: () => {
                /* 真实实现里中止命令 */
              },
            });
            // 永不结算：轮末闸门会一直续轮直到打满上限
          }
        },
      } as unknown as KenFutWorkAgent;
    };
    const runtime = createAgentRunService({
      agentFactory,
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
        resolveWorkspace: async () => ({ id: "ws-cap-test" }),
      } as never,
      agentPersistenceService: {
        getPersistence: async () => ({ checkpointer: null, store: null }),
      } as never,
      agentRunMetadataService: { updateRun: async () => {} } as never,
      settingsService: {
        getWorkspaceSettings: async () => ({
          defaultModel: "test-model",
          agentMaxRetries: 0,
          terminalShell: "auto",
          codeIndexEnabled: false,
          codeIndexAutoNewFolder: false,
          autoCompactEnabled: false,
          commands: [],
          hooks: [],
          userRules: "",
          ruleEntries: [],
          subagentMaxDepth: 1,
          subagentMaxConcurrency: 4,
          llmRequestMaxRetries: 10,
          llmInfiniteRetry: false,
          executeTimeoutMs: 120000,
          subagentMaxContinuations: 2,
        }),
      } as never,
    });
    const runId = makeRun(runtime);
    const events = await pump(runtime, runId);

    // 上限 2：首跑 + 至多 2 次续轮；终态放行、不再无限循环
    expect(rounds).toBeLessThanOrEqual(3);
    expect(events.at(-1)?.type).toBe("run.completed");
    // 打满上限：挂死任务被 abortAll 收割，取消通知到达前端
    const notifications = events.filter((e) => e.type === "task.notification");
    expect(
      notifications.some(
        (n) => (n as { status: string }).status === "canceled",
      ),
    ).toBe(true);
  });
});
