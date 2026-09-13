import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import type {
  LoomicAgent,
  LoomicAgentFactory,
  ToolGate,
} from "../../agent/deep-agent.js";
import { createAgentModesPlugin } from "../agent-modes/plugin.js";
import { composePlugins } from "../../kernel/compose.js";
import {
  AgentRunEventBus,
  createKernelEvents,
  ToolDeniedError,
} from "../../kernel/context.js";
import { createAgentRunsPlugin } from "./plugin.js";
import type { StreamEvent } from "@loomic/shared";

/**
 * 装配缝回归（P0 事故防复发）：
 * 「profile 装配 → runtime 真拿到 emitPreStep/toolGate」这条缝曾被漏接
 * （装配层传了 events 却没传 emitPreStep，runtime 静默原样返回输入，执行模式
 * 全部空壳）。本测试按 server profile 的真实接线方式组合 agent-modes +
 * agent-runs 两个插件，断言：指令真的进了模型输入、工具门真的在拒绝工具。
 * 单测各自直接调 service/事件总线，覆盖不到这条装配缝——必须组合验证。
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

const stubPersistence = {
  execute: async () => ({ rows: [] }),
  forWorkspace: () => ({
    execute: async () => ({ rows: [] }),
    query: async () => [],
  }),
  query: async () => [],
};

async function drainRun(stream: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("agent-runs × agent-modes 装配缝（pre-step 指令 + 工具门）", () => {
  it("plan 模式：指令注入模型输入，工具门只读放行/写操作拒绝", async () => {
    const gates: Array<ToolGate | undefined> = [];
    const inputs: Array<{ messages: Array<{ content: unknown }> }> = [];
    const agentFactory: LoomicAgentFactory = (options) => {
      gates.push(options.toolGate);
      return {
        streamEvents: async function* (input: never) {
          inputs.push(input);
        },
      } as unknown as LoomicAgent;
    };

    const { kernel, app } = assembleSeamKernel(agentFactory);
    try {
      const threadId = "thread-seam-plan";
      kernel.get("agentModes").activate(threadId, "plan");

      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-seam-1",
          canvasId: "conv-seam-1",
          conversationId: "conv-seam-1",
          prompt: "帮我搭一个 python 项目",
        },
        { accessToken: "tok", threadId, userId: "u1" },
      );
      const events = await drainRun(runs.streamRun(runId));
      expect(events.at(-1)?.type).toBe("run.completed");

      // pre-step 指令注入：装配层把 emitPreStep 递给了 runtime
      const content = String(inputs[0]?.messages?.[0]?.content);
      expect(content).toContain('<execution_mode name="plan">');
      expect(content).toContain("帮我搭一个 python 项目");

      // 工具门：plan 只读——read_file 放行，write_file/execute 拒绝
      const gate = gates[0];
      expect(gate).toBeDefined();
      expect(gate?.("read_file")).toEqual({ allowed: true });
      expect(gate?.("write_file")?.allowed).toBe(false);
      expect(gate?.("execute")?.allowed).toBe(false);
    } finally {
      kernel.dispose();
      await app.close();
    }
  });

  it("solo 模式：工具门全禁，内核注册表 guarded 执行同步拒绝", async () => {
    const gates: Array<ToolGate | undefined> = [];
    const agentFactory: LoomicAgentFactory = (options) => {
      gates.push(options.toolGate);
      return {
        streamEvents: async function* () {},
      } as unknown as LoomicAgent;
    };

    const { kernel, app } = assembleSeamKernel(agentFactory);
    try {
      const threadId = "thread-seam-solo";
      kernel.get("agentModes").activate(threadId, "solo");

      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-seam-2",
          canvasId: "conv-seam-2",
          conversationId: "conv-seam-2",
          prompt: "纯聊天",
        },
        { accessToken: "tok", threadId, userId: "u1" },
      );
      await drainRun(runs.streamRun(runId));

      const gate = gates[0];
      expect(gate?.("web_search")?.allowed).toBe(false);
      expect(gate?.("write_todos")?.allowed).toBe(false);

      // 内核缝：注册表工具经 guarded 执行派发（tool-pre-execute 带 threadId）
      const tools = kernel.get("tools");
      const unregister = tools.register({
        name: "seam_probe_tool",
        description: "缝探针工具",
        scope: "shared",
        parameters: { type: "object" },
        execute: async () => "ok",
      });
      try {
        await expect(
          tools.execute("seam_probe_tool", {}, { threadId }),
        ).rejects.toThrow(ToolDeniedError);
        // 无 threadId 上下文的调用不受线程策略影响（无会话路径如队列任务）
        await expect(tools.execute("seam_probe_tool", {}, {})).resolves.toBe(
          "ok",
        );
      } finally {
        unregister();
      }
    } finally {
      kernel.dispose();
      await app.close();
    }
  });
});

/** 按 server profile 的真实接线方式组合内核（events + emitPreStep 同源）。 */
function assembleSeamKernel(agentFactory: LoomicAgentFactory) {
  const bus = new AgentRunEventBus();
  const kernelEvents = createKernelEvents(bus);
  const app = Fastify();
  const kernel = composePlugins(
    makeEnv(),
    [
      createAgentModesPlugin(),
      createAgentRunsPlugin({
        connectionManager: {
          pushToCanvas: () => {},
          remove: () => {},
        } as never,
        events: kernelEvents,
        emitPreStep: (payload) => kernelEvents.emitPreStep(payload),
        agentFactory,
      }),
    ],
    {
      app,
      events: bus,
      overrides: {
        auth: { authenticate: async () => null },
        blob: {} as never,
        brandKit: {} as never,
        canvas: {} as never,
        credits: {} as never,
        modelProviders: {} as never,
        persistence: stubPersistence as never,
        runUsage: {} as never,
        settings: {} as never,
        threads: {} as never,
        tierGuard: {} as never,
        viewer: {
          resolveWorkspace: async () => {
            throw new Error("no viewer in seam test");
          },
        } as never,
      },
    },
  );
  return { kernel, app };
}
