import { tmpdir } from "node:os";
import { instanceSettingsSchema, type StreamEvent } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  KenFutWorkAgent,
  KenFutWorkAgentFactory,
} from "../../agent/deep-agent.js";
import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { AgentRunEventBus, createKernelEvents } from "../../kernel/context.js";
import { createAgentModesPlugin } from "../agent-modes/plugin.js";
import { createAgentRunsPlugin } from "../agent-runs/plugin.js";
import { createContextHistoryPlugin } from "../context-history/plugin.js";
import { createKnowledgePlugin } from "../knowledge/plugin.js";
import type { SagRunner } from "../knowledge/sag-cli-runner.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createMemoryTaskWorkManager } from "../task-work/test-store.js";

/**
 * 「证据真的进了模型输入」装配缝测试。
 *
 * 单测只证明 preflight 监听器返回了带证据的 payload；本测试按 server profile 的
 * 真实接线组合 knowledge + agent-runs，断言 runtime 构造出的模型输入里确实出现
 * `<knowledge_evidence>`。这是「装完就走知识库」的最终证据。
 */

const ACTOR = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  accessClientId: null,
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanups.splice(0)) await release();
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
  execute: async () => 0,
  forInstance: () => ({
    execute: async () => 0,
    query: async () => [],
    queryOne: async () => undefined,
  }),
  query: async () => [],
};

/** 假 CLI：凭据已就位 + 根已索引 + 命中一条证据，不需要真装 sag。 */
function fakeSagRunner(): SagRunner {
  return async (run) => {
    const args = run.args;
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "config") {
      return args.length === 1
        ? ok(
            JSON.stringify({
              url: "https://api.302ai.cn/typesafeai/v1",
              model: "jev-latest",
              models: [],
              has_key: true,
              auth_mode: "bearer",
            }),
          )
        : ok("{}");
    }
    if (args[0] === "list")
      return ok(
        JSON.stringify([
          {
            path: "D:/kb",
            name: "kb",
            status: "ready",
            count: 1,
            error: null,
          },
        ]),
      );
    if (args[0] === "check")
      return ok(
        JSON.stringify({
          path: "D:/kb",
          coverage: "included",
          index_ready: true,
          enabled: true,
          indexed_files: 1,
          roots: [],
        }),
      );
    // 检索（语义档）
    return ok(
      JSON.stringify({
        protocol_version: 2,
        scope: "D:/kb",
        results: [
          {
            path: "note.md",
            absolute_path: "D:/kb/note.md",
            start_line: 3,
            end_line: 3,
            content: "林远是平台组负责人。",
          },
        ],
        files: [],
        matched: true,
        truncated: false,
      }),
    );
  };
}

async function assembleKernel(
  agentFactory: KenFutWorkAgentFactory,
  installed: boolean,
) {
  // 轻量注册表替身：只回答安装态（本测试关心的是证据是否进模型输入）。
  const registry = {
    installed,
    async list() {
      return [
        {
          id: "kenfutwork-knowledge",
          name: "kenfutwork-knowledge",
          installed: this.installed,
          enabled: true,
        },
      ];
    },
    listUiEntries() {
      return this.installed
        ? [
            {
              pluginId: "local__kenfutwork-knowledge",
              id: "knowledge-sidebar",
            },
          ]
        : [];
    },
    listPromptFragments: () => [],
    readSkillPackages: async () => [],
    readPackageInventory: async () => ({
      rootPath: tmpdir(),
      bundled: [],
      installed: [],
    }),
  };
  const bus = new AgentRunEventBus();
  const permissions = createPermissionService();
  const kernelEvents = createKernelEvents(bus);
  const app = Fastify();
  const kernel = composePlugins(
    makeEnv(),
    [
      createAgentModesPlugin(),
      createContextHistoryPlugin(),
      createKnowledgePlugin({
        platform: "win32",
        probeCli: async () => true,
        runner: fakeSagRunner(),
        // 让知识库「已安装」：市场 bundle 的安装态由 registry 决定
        readJevCredential: async () => "jev-key-123",
      }),
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
        plugins: registry as never,
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
          repository: { ensure: async () => ACTOR.instanceId },
          dataDir: tmpdir(),
        }),
      },
    },
  );
  return { kernel, app, registry };
}

async function drainRun(stream: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("knowledge × agent-runs 装配缝（证据进入模型输入）", () => {
  it("已安装时：runtime 的模型输入含 <knowledge_evidence> 与真实证据", async () => {
    const inputs: Array<{ messages: Array<{ content: unknown }> }> = [];
    const agentFactory: KenFutWorkAgentFactory = () => {
      return {
        streamEvents: async function* (input: never) {
          inputs.push(input);
          yield {
            event: "on_chat_model_stream",
            data: { chunk: { content: "林远是平台组负责人。" } },
          };
        },
      } as unknown as KenFutWorkAgent;
    };

    const { kernel, app } = await assembleKernel(agentFactory, true);
    try {
      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-kb-1",
          canvasId: "conv-kb-1",
          conversationId: "conv-kb-1",
          prompt: "林远是谁",
        },
        { actor: ACTOR, threadId: "thread-kb-1" },
      );
      const events = await drainRun(runs.streamRun(runId));
      expect(events.at(-1)?.type).toBe("run.completed");

      const content = String(inputs[0]?.messages?.[0]?.content);
      expect(content).toContain("<knowledge_evidence>");
      expect(content).toContain("D:/kb/note.md:3-3");
      expect(content).toContain("林远是平台组负责人。");
      // 凭据就位时走语义档：证据块措辞必须是语义检索，不能冒充本地匹配
      expect(content).toContain("自动检索到的本地知识库证据");
      expect(content).not.toContain("本地匹配");
    } finally {
      kernel.dispose();
      await app.close();
    }
  });

  it("未安装时：模型输入不含证据块（装/卸下一轮即生效）", async () => {
    const inputs: Array<{ messages: Array<{ content: unknown }> }> = [];
    const agentFactory: KenFutWorkAgentFactory = () => {
      return {
        streamEvents: async function* (input: never) {
          inputs.push(input);
          yield {
            event: "on_chat_model_stream",
            data: { chunk: { content: "ok" } },
          };
        },
      } as unknown as KenFutWorkAgent;
    };

    const { kernel, app } = await assembleKernel(agentFactory, false);
    try {
      const runs = kernel.get("agentRuns");
      const { runId } = runs.createRun(
        {
          sessionId: "sess-kb-2",
          canvasId: "conv-kb-2",
          conversationId: "conv-kb-2",
          prompt: "林远是谁",
        },
        { actor: ACTOR, threadId: "thread-kb-2" },
      );
      await drainRun(runs.streamRun(runId));
      const content = String(inputs[0]?.messages?.[0]?.content);
      expect(content).not.toContain("<knowledge_evidence>");
      expect(content).toContain("林远是谁");
    } finally {
      kernel.dispose();
      await app.close();
    }
  });
});
