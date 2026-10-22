import { tmpdir } from "node:os";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import type { KenFutWorkAgentFactory } from "../../agent/deep-agent.js";
import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import {
  AgentRunEventBus,
  createKernelEvents,
  ToolDeniedError,
} from "../../kernel/context.js";
import { createPluginInventoryFixture } from "../code-ui/plugins.test-fixture.js";
import { createContextHistoryPlugin } from "../context-history/plugin.js";
import { archiveTaskFixture } from "../context-history/test-fixture.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createMemoryTaskWorkManager } from "../task-work/test-store.js";
import { createAgentRunsPlugin } from "./plugin.js";

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
  const events = createKernelEvents(bus);
  const app = Fastify();
  const kernel = composePlugins(
    makeEnv(),
    [
      createContextHistoryPlugin(),
      createAgentRunsPlugin({
        connectionManager: {
          pushToCanvas: () => {},
          remove: () => {},
        } as never,
        events,
        emitPreStep: (payload) => events.emitPreStep(payload),
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

it("统一Agent无需执行方式服务即可读取Task授权目录", async () => {
  const task = await archiveTaskFixture("code");
  const { kernel, app } = await assembleSeamKernel(() => {
    throw new Error("目录读取不调用模型");
  });
  const definition = {
    name: "Read",
    description: "读取Task目录",
    scope: "shared" as const,
    access: "read" as const,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => task.handle.backend.listDirectory("."),
  };
  const unregister = kernel.get("tools").register(definition);
  try {
    kernel.get("agentRuns");
    await expect(
      kernel.get("tools").executeDefinition(definition, {}, task.execution),
    ).resolves.toEqual([]);
  } finally {
    unregister();
    await kernel.dispose();
    await app.close();
    await task.cleanup();
  }
});

it("独立Plan允许读取并阻止真实文件写入", async () => {
  const task = await archiveTaskFixture("design");
  const { kernel, app } = await assembleSeamKernel(() => {
    throw new Error("文件操作不调用模型");
  });
  const execution = {
    ...task.execution,
    codeApproval: {
      ceiling: "yolo" as const,
      resolve: async () => ({
        mode: "plan" as const,
        planEnabled: true,
        planningEpoch: 1,
        scopeGeneration: task.identity.generation,
        branchGeneration: 1,
      }),
    },
  };
  const read = {
    name: "Read",
    description: "读取目录",
    scope: "shared" as const,
    access: "read" as const,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => task.handle.backend.listDirectory("."),
  };
  const write = {
    ...read,
    name: "Write",
    access: "write" as const,
    execute: async () =>
      task.handle.backend.writeFile({
        path: "blocked.txt",
        content: "blocked",
      }),
  };
  const unregisterRead = kernel.get("tools").register(read);
  const unregisterWrite = kernel.get("tools").register(write);
  try {
    await expect(
      kernel.get("tools").executeDefinition(read, {}, execution),
    ).resolves.toEqual([]);
    await expect(
      kernel.get("tools").executeDefinition(
        write,
        {},
        {
          ...execution,
          toolCallId: `${execution.toolCallId}-write`,
        },
      ),
    ).rejects.toThrow(ToolDeniedError);
    expect(await task.handle.backend.listDirectory(".")).toEqual([]);
  } finally {
    unregisterRead();
    unregisterWrite();
    await kernel.dispose();
    await app.close();
    await task.cleanup();
  }
});

it("Task接纳build后当前配置切yolo仍须原调用审批", async () => {
  const task = await archiveTaskFixture("code");
  const { kernel, app } = await assembleSeamKernel(() => {
    throw new Error("本例只使用真实Kernel和审批服务");
  });
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
    execute: async () =>
      task.handle.backend.writeFile({
        path: "blocked.txt",
        content: "blocked",
      }),
  };
  const unregister = kernel.get("tools").register(definition);
  try {
    await expect(
      kernel.get("tools").executeDefinition(
        definition,
        {},
        {
          ...task.execution,
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
    expect(await task.handle.backend.listDirectory(".")).toEqual([]);
  } finally {
    unregister();
    await kernel.dispose();
    await app.close();
    await task.cleanup();
  }
});
