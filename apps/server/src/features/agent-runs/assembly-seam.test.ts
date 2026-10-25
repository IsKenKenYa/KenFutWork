import { tmpdir } from "node:os";
import { instanceSettingsSchema, type StreamEvent } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  KenFutWorkAgent,
  KenFutWorkAgentFactory,
  ToolGate,
} from "../../agent/deep-agent.js";
import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import {
  AgentRunEventBus,
  createKernelEvents,
  ToolDeniedError,
} from "../../kernel/context.js";
import { createAgentModesPlugin } from "../agent-modes/plugin.js";
import { createPluginInventoryFixture } from "../code-ui/plugins.test-fixture.js";
import { createContextHistoryPlugin } from "../context-history/plugin.js";
import { archiveTaskFixture } from "../context-history/test-fixture.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createMemoryTaskWorkManager } from "../task-work/test-store.js";
import { createAgentRunsPlugin } from "./plugin.js";

/**
 * 装配缝回归（P0 事故防复发）：
 * 「profile 装配 → runtime 真拿到 emitPreStep/toolGate」这条缝曾被漏接
 * （装配层传了 events 却没传 emitPreStep，runtime 静默原样返回输入，执行模式
 * 全部空壳）。本测试按 server profile 的真实接线方式组合 agent-modes +
 * agent-runs 两个插件，断言：指令真的进了模型输入、工具门真的在拒绝工具。
 * 单测各自直接调 service/事件总线，覆盖不到这条装配缝——必须组合验证。
 */

const SEAM_ACTOR = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  accessClientId: null,
};
const pluginCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of pluginCleanups.splice(0)) await release();
});

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
  forInstance: () => ({
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
    const agentFactory: KenFutWorkAgentFactory = (options) => {
      gates.push(options.toolGate);
      return {
        streamEvents: async function* (input: never) {
          inputs.push(input);
          yield {
            event: "on_chat_model_stream",
            data: { chunk: { content: "已列出项目规划" } },
          };
        },
      } as unknown as KenFutWorkAgent;
    };

    const { kernel, app } = await assembleSeamKernel(agentFactory);
    try {
      const threadId = "thread-seam-plan";
      await kernel.get("agentModes").activate(threadId, "plan");

      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-seam-1",
          canvasId: "conv-seam-1",
          conversationId: "conv-seam-1",
          prompt: "帮我搭一个 python 项目",
        },
        { actor: SEAM_ACTOR, threadId },
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

  it("solo 模式：工具门严格只读（白名单放行、写/执行拒绝），内核注册表 guarded 执行同步拒绝", async () => {
    const gates: Array<ToolGate | undefined> = [];
    const agentFactory: KenFutWorkAgentFactory = (options) => {
      gates.push(options.toolGate);
      return {
        streamEvents: async function* () {
          yield {
            event: "on_chat_model_stream",
            data: { chunk: { content: "纯聊天回复" } },
          };
        },
      } as unknown as KenFutWorkAgent;
    };

    const { kernel, app } = await assembleSeamKernel(agentFactory);
    try {
      const threadId = "thread-seam-solo";
      await kernel.get("agentModes").activate(threadId, "solo");

      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-seam-2",
          canvasId: "conv-seam-2",
          conversationId: "conv-seam-2",
          prompt: "纯聊天",
        },
        { actor: SEAM_ACTOR, threadId },
      );
      await drainRun(runs.streamRun(runId));

      const gate = gates[0];
      // solo 严格只读：只读白名单放行，写/执行/终端拒绝
      expect(gate?.("web_search")).toEqual({ allowed: true });
      expect(gate?.("write_todos")).toEqual({ allowed: true });
      expect(gate?.("write_file")?.allowed).toBe(false);
      expect(gate?.("execute")?.allowed).toBe(false);
      expect(gate?.("Bash")?.allowed).toBe(false);
      expect(gate?.("subagent_task", { subagentReadOnly: true })?.allowed).toBe(
        false,
      );

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
async function assembleSeamKernel(agentFactory: KenFutWorkAgentFactory) {
  const inventory = await createPluginInventoryFixture();
  pluginCleanups.push(inventory.dispose);
  const bus = new AgentRunEventBus();
  const permissions = createPermissionService();
  bus.on("tool-pre-execute", async (payload, next) => {
    if (!payload.permissionInvocation) return next(payload);
    const decision = await permissions.admit(payload.permissionInvocation);
    return next({
      ...payload,
      decision: decision.decision,
      ...(decision.reason ? { denyReason: decision.reason } : {}),
    });
  });
  const kernelEvents = createKernelEvents(bus);
  const app = Fastify();
  const kernel = composePlugins(
    makeEnv(),
    [
      createAgentModesPlugin(),
      createContextHistoryPlugin(),
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
        permissions,
        plugins: inventory.registry,
        taskWork: createMemoryTaskWorkManager(),
        processSandbox: {} as never,
        executionScopes: {} as never,
        codeUi: {} as never,
        localAccess: { authenticate: async () => null } as never,
        blob: {} as never,
        brandKit: {} as never,
        canvas: {} as never,
        modelProviders: {} as never,
        persistence: stubPersistence as never,
        runUsage: {} as never,
        settings: {
          getInstanceSettings: async () =>
            instanceSettingsSchema.parse({ defaultModel: "test-model" }),
        } as never,
        threads: {} as never,
        localInstance: createLocalInstanceService({
          repository: { ensure: async () => SEAM_ACTOR.instanceId },
          dataDir: tmpdir(),
        }),
      },
    },
  );
  return { kernel, app };
}

it.each(["solo", "plan"] as const)(
  "Design %s mode still gates actual Kernel permission invocations",
  async (mode) => {
    const task = await archiveTaskFixture("design");
    const { kernel, app } = await assembleSeamKernel(() => {
      throw new Error("No native agent needed");
    });
    let executed = 0;
    try {
      const threadId = `design-mode-${mode}`;
      await kernel.get("agentModes").activate(threadId, mode);
      const execution = {
        ...task.execution,
        threadId,
        codeApproval: {
          ceiling: "yolo" as const,
          resolve: async () => ({
            mode: "yolo" as const,
            scopeGeneration: task.identity.generation,
            branchGeneration: 1,
          }),
        },
      };
      const tools = kernel.get("tools");
      const definition = {
        name: "Write",
        description: "actual Design write probe",
        scope: "shared" as const,
        access: "write" as const,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          executed++;
          return "written";
        },
      };
      const unregister = tools.register(definition);
      try {
        // 写操作两档都硬拒；属主声明只读（access=read）两档都放行
        await expect(
          tools.executeDefinition(definition, {}, execution),
        ).rejects.toThrow(ToolDeniedError);
        expect(executed).toBe(0);
        const read = { ...definition, name: "Read", access: "read" as const };
        const unregisterRead = tools.register(read);
        try {
          await expect(
            tools.executeDefinition(read, {}, {
              ...execution,
              toolCallId: `${task.execution.toolCallId}-read`,
            }),
          ).resolves.toBe("written");
          expect(executed).toBe(1);
        } finally {
          unregisterRead();
        }
      } finally {
        unregister();
      }
    } finally {
      await kernel.dispose();
      await app.close();
      await task.cleanup();
    }
  },
);

it("共享Task以Run冻结solo硬拒绝写入工具，后切会话策略不追改已接纳agent", async () => {
  const task = await archiveTaskFixture("code");
  const { kernel, app } = await assembleSeamKernel(() => {
    throw new Error("本例在真实Kernel执行缝验证，不运行模型");
  });
  let writes = 0;
  try {
    const threadId = "frozen-task-strategy";
    await kernel.get("agentModes").activate(threadId, "agent");
    const definition = {
      name: "Write",
      description: "写入Task文件",
      scope: "shared" as const,
      access: "write" as const,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        writes++;
        return "实际写入结果";
      },
    };
    const unregister = kernel.get("tools").register(definition);
    try {
      // yolo 天花板让权限维度直接放行，模式门成为唯一拦截者（否则审批等待会挂起）
      const execution = {
        ...task.execution,
        threadId,
        codeApproval: {
          ceiling: "yolo" as const,
          resolve: async () => ({
            mode: "yolo" as const,
            scopeGeneration: task.identity.generation,
            branchGeneration: 1,
          }),
        },
      };
      await expect(
        kernel.get("tools").executeDefinition(
          definition,
          {},
          {
            ...execution,
            executionMode: "solo",
          },
        ),
      ).rejects.toThrow(/solo/);
      expect(writes).toBe(0);
      await kernel.get("agentModes").activate(threadId, "solo");
      await expect(
        kernel.get("tools").executeDefinition(
          definition,
          {},
          {
            ...execution,
            executionMode: "agent",
            toolCallId: "frozen-agent-write",
          },
        ),
      ).resolves.toBe("实际写入结果");
      expect(writes).toBe(1);
    } finally {
      unregister();
    }
  } finally {
    await kernel.dispose();
    await app.close();
    await task.cleanup();
  }
});

it("共享Task主Run接纳build后当前配置切yolo，写入仍须原调用审批", async () => {
  const task = await archiveTaskFixture("code");
  const { kernel, app } = await assembleSeamKernel(() => {
    throw new Error("本例只使用真实Kernel和审批门");
  });
  let writes = 0;
  const requested: string[] = [];
  const permissions = kernel.get("permissions");
  permissions.onEvent(async (event) => {
    if (event.type !== "requested") return;
    requested.push(event.identity.toolCallId);
    await permissions.resolve({
      interactionId: event.interaction.interactionId,
      binding: event.identity,
      answer: { optionId: "deny" },
    });
  });
  const definition = {
    name: "Write",
    description: "写入Task文件",
    scope: "shared" as const,
    access: "write" as const,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      writes++;
      return "written";
    },
  };
  const unregister = kernel.get("tools").register(definition);
  try {
    await expect(
      kernel.get("tools").executeDefinition(
        definition,
        {},
        {
          ...task.execution,
          executionMode: "agent",
          codeApproval: {
            ceiling: "build",
            resolve: async () => ({
              mode: "yolo",
              scopeGeneration: task.identity.generation,
              branchGeneration: 1,
            }),
          },
        },
      ),
    ).rejects.toThrow(ToolDeniedError);
    expect(requested).toEqual([task.execution.toolCallId]);
    expect(writes).toBe(0);
  } finally {
    unregister();
    await kernel.dispose();
    await app.close();
    await task.cleanup();
  }
});
