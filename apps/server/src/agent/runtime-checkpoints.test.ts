import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import type { KenFutWorkAgent, KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";
import { resolveSandboxDir } from "./sandbox-dir.js";

/**
 * 检查点钩子接进 agent 运行时（切片3）。
 *
 * 锁四件事：轮次钩子在正确时机被调（beforeTurn 在流事件之前、afterTurn 在 finally
 * 里成功/失败都走到）；钩子是旁路（抛错不影响 run 终态）；hasActiveRunForCanvas
 * 的在途判定（accepted/running + canvasId/sandboxScopeId 两分支）；dev ephemeral
 * 后端不打钩子（目录随 run 删除，打了也白打）。
 */

const CANVAS_ID = "canvas-ckpt-1";

type HookCall = {
  hook: "before" | "after";
  canvasId: string;
  sandboxDir: string;
  runId: string;
};

type TurnContext = {
  canvasId: string;
  sandboxDir: string;
  runId: string;
};

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "kfw-runtime-ckpt-"));
}

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
    sandboxRoot: makeRoot(),
    ...overrides,
  };
}

/** 正常完成一次 run 的 agent：不产出任何事件——适配器在流正常收尾时补 run.completed。 */
function makeIdleAgentFactory(): KenFutWorkAgentFactory {
  return (() => ({
    streamEvents: async function* () {},
  })) as unknown as KenFutWorkAgentFactory;
}

/** 装配期直接抛错的 agent 工厂（run 失败路径）。 */
function makeThrowingAgentFactory(): KenFutWorkAgentFactory {
  return (() => {
    throw new Error("装配失败");
  }) as unknown as KenFutWorkAgentFactory;
}

/** 只有本轮被取消（signal abort）才结束的 agent（复用 cancel 测试的范式）。 */
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

function makeRuntime(input: {
  env: ServerEnv;
  agentFactory: KenFutWorkAgentFactory;
  checkpointHooks?: {
    beforeTurn(ctx: TurnContext): Promise<void>;
    afterTurn(ctx: TurnContext): Promise<void>;
  };
}) {
  return createAgentRunService({
    agentFactory: input.agentFactory,
    ...(input.checkpointHooks
      ? { checkpointHooks: input.checkpointHooks }
      : {}),
    blob: { upload: async () => ({}) } as never,
    env: input.env,
    modelProviders: {
      getInstanceScope: async () => "workspace",
      resolveCredentials: async () => ({
        apiKey: "sk-test",
        protocol: "openai-compatible",
      }),
    } as never,
    viewerService: {
      resolveWorkspace: async () => ({ id: "ws-ckpt" }),
    } as never,
    agentPersistenceService: {
      getPersistence: async () => ({ checkpointer: null, store: null }),
    } as never,
    agentRunMetadataService: {
      updateRun: async () => {},
    } as never,
  });
}

const drain = async (
  runtime: ReturnType<typeof createAgentRunService>,
  runId: string,
  timeline: string[],
): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of runtime.streamRun(runId)) {
    events.push(event);
    timeline.push(`event:${event.type}`);
  }
  return events;
};

const waitForEvent = async (
  events: StreamEvent[],
  type: string,
): Promise<void> => {
  for (let i = 0; i < 200 && !events.some((e) => e.type === type); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("agent 运行时的检查点钩子", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const track = <T extends string>(root: T): T => {
    roots.push(root);
    return root;
  };

  it("正常 run：beforeTurn/afterTurn 各一次，sandboxDir 与后端解析一致，beforeTurn 在流事件之前", async () => {
    const env = makeEnv();
    track(env.sandboxRoot as string);
    const calls: HookCall[] = [];
    const timeline: string[] = [];
    const runtime = makeRuntime({
      env,
      agentFactory: makeIdleAgentFactory(),
      checkpointHooks: {
        beforeTurn: async (ctx) => {
          calls.push({ hook: "before", ...ctx });
          timeline.push("beforeTurn");
        },
        afterTurn: async (ctx) => {
          calls.push({ hook: "after", ...ctx });
          timeline.push("afterTurn");
        },
      },
    });
    const { runId } = runtime.createRun(
      {
        canvasId: CANVAS_ID,
        conversationId: CANVAS_ID,
        prompt: "画点什么",
        sessionId: "sess-1",
      },
      { threadId: "thread-1", userId: "u-1" },
    );

    const events = await drain(runtime, runId, timeline);

    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      hook: "before",
      canvasId: CANVAS_ID,
      runId,
    });
    expect(calls[1]).toMatchObject({
      hook: "after",
      canvasId: CANVAS_ID,
      runId,
    });
    // 与后端同一处解析（含 realpath）：快照的就是 agent 读写的那个目录
    expect(calls[0]?.sandboxDir).toBe(
      realpathSync(resolveSandboxDir(CANVAS_ID, env.sandboxRoot)),
    );
    // 时序：beforeTurn 早于一切流事件；afterTurn 在收尾（所有事件之后）
    expect(timeline[0]).toBe("beforeTurn");
    expect(timeline.at(-1)).toBe("afterTurn");
  });

  it("run 失败路径（factory 抛错）：afterTurn 仍被调用，run.failed 照常发出", async () => {
    const env = makeEnv();
    track(env.sandboxRoot as string);
    const calls: HookCall[] = [];
    const runtime = makeRuntime({
      env,
      agentFactory: makeThrowingAgentFactory(),
      checkpointHooks: {
        beforeTurn: async (ctx) => {
          calls.push({ hook: "before", ...ctx });
        },
        afterTurn: async (ctx) => {
          calls.push({ hook: "after", ...ctx });
        },
      },
    });
    const { runId } = runtime.createRun({
      canvasId: CANVAS_ID,
      conversationId: CANVAS_ID,
      prompt: "会失败的 run",
      sessionId: "sess-2",
    });

    const timeline: string[] = [];
    const events = await drain(runtime, runId, timeline);

    expect(events.some((e) => e.type === "run.failed")).toBe(true);
    // 装配失败发生在 beforeTurn 调用点之前：只有 afterTurn 走到（finally 保证）
    expect(calls.map((c) => c.hook)).toEqual(["after"]);
    expect(calls[0]?.runId).toBe(runId);
    expect(calls[0]?.canvasId).toBe(CANVAS_ID);
  });

  it("checkpointHooks.beforeTurn 抛错：run 不受影响，事件流完整，afterTurn 照走", async () => {
    const env = makeEnv();
    track(env.sandboxRoot as string);
    const calls: HookCall[] = [];
    const runtime = makeRuntime({
      env,
      agentFactory: makeIdleAgentFactory(),
      checkpointHooks: {
        beforeTurn: async () => {
          throw new Error("检查点炸了");
        },
        afterTurn: async (ctx) => {
          calls.push({ hook: "after", ...ctx });
        },
      },
    });
    const { runId } = runtime.createRun({
      canvasId: CANVAS_ID,
      conversationId: CANVAS_ID,
      prompt: "钩子炸但 run 要活",
      sessionId: "sess-3",
    });

    const timeline: string[] = [];
    const events = await drain(runtime, runId, timeline);

    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    expect(events.some((e) => e.type === "run.failed")).toBe(false);
    expect(calls.map((c) => c.hook)).toEqual(["after"]);
  });

  it("hasActiveRunForCanvas：accepted/running 算在途（canvasId 与 sandboxScopeId 两分支都认），终态不算", async () => {
    const env = makeEnv();
    track(env.sandboxRoot as string);
    const runtime = makeRuntime({
      env,
      agentFactory: makeHangingAgentFactory(),
    });
    const { runId } = runtime.createRun(
      {
        canvasId: "session-scope-id",
        conversationId: "session-scope-id",
        prompt: "挂着",
        sessionId: "sess-4",
      },
      { sandboxScopeId: CANVAS_ID, threadId: "thread-4", userId: "u-4" },
    );

    // accepted（尚未开跑）即在途：恢复路由据此拒绝
    expect(runtime.hasActiveRunForCanvas(CANVAS_ID)).toBe(true);

    const events: StreamEvent[] = [];
    const pump = (async () => {
      for await (const event of runtime.streamRun(runId)) {
        events.push(event);
      }
    })();
    await waitForEvent(events, "run.started");
    expect(events.some((e) => e.type === "run.started")).toBe(true);

    // running：canvasId（会话作用域）与 sandboxScopeId（画布作用域）都命中
    expect(runtime.hasActiveRunForCanvas("session-scope-id")).toBe(true);
    expect(runtime.hasActiveRunForCanvas(CANVAS_ID)).toBe(true);
    expect(runtime.hasActiveRunForCanvas("别的画布")).toBe(false);

    expect(runtime.cancelRun(runId)).not.toBeNull();
    await pump;
    expect(events.at(-1)?.type).toBe("run.canceled");
    expect(runtime.hasActiveRunForCanvas(CANVAS_ID)).toBe(false);
    expect(runtime.hasActiveRunForCanvas("session-scope-id")).toBe(false);
  });

  it("dev ephemeral 后端（filesystem 模式）：不打钩子", async () => {
    const filesRoot = track(makeRoot());
    const env = makeEnv({
      agentBackendMode: "filesystem",
      agentFilesRoot: filesRoot,
    });
    track(env.sandboxRoot as string);
    const calls: HookCall[] = [];
    const runtime = makeRuntime({
      env,
      agentFactory: makeIdleAgentFactory(),
      checkpointHooks: {
        beforeTurn: async (ctx) => {
          calls.push({ hook: "before", ...ctx });
        },
        afterTurn: async (ctx) => {
          calls.push({ hook: "after", ...ctx });
        },
      },
    });
    const { runId } = runtime.createRun({
      canvasId: CANVAS_ID,
      conversationId: CANVAS_ID,
      prompt: "dev 临时目录",
      sessionId: "sess-5",
    });

    const timeline: string[] = [];
    const events = await drain(runtime, runId, timeline);

    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    expect(calls).toEqual([]);
  });
});
