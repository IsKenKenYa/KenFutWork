import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { AgentRunEventBus } from "../../kernel/context.js";
import { createPermissionService } from "../permissions/permission-service.js";
import {
  PLUGIN_STATE_LIFECYCLE_CAPABILITY,
  type PluginStateLifecycle,
  type PluginStateRevokingEvent,
} from "../plugins/state-lifecycle.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import { createCadPlugin } from "./plugin.js";
import { createCadTestContext } from "./test-fixtures.js";

it("真实 CAD 动态注册的旧审批及冻结贡献不能跨停用启用复活", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-cad-epoch-")));
  const task = await createCadTestContext(root);
  const permissions = createPermissionService();
  const events = new AgentRunEventBus();
  events.on("tool-pre-execute", async (payload, next) => {
    if (!payload.permissionInvocation) return next(payload);
    const result = await permissions.admit(payload.permissionInvocation);
    return next({
      ...payload,
      decision: result.decision,
      ...(result.reason ? { denyReason: result.reason } : {}),
    });
  });
  const spawn = vi.fn(async () => {
    throw new Error("不应派发旧调用");
  });
  const kernel = composePlugins(loadServerEnv({}, {}), [createCadPlugin()], {
    events,
    overrides: {
      permissions,
      processSandbox: { spawnStdio: spawn } as unknown as ProcessSandbox,
      settings: {
        getInstanceSettings: async () =>
          instanceSettingsSchema.parse({ defaultModel: "" }),
      } as never,
      plugins: {
        list: async () => [
          {
            id: "bundled__kenfutwork-cad",
            name: "kenfutwork-cad",
            installed: true,
            enabled: true,
          },
        ],
      } as never,
    },
  });
  const registry = kernel.get("tools");
  expect(registry.captureContributions("code").entries).toEqual([]);
  const lifecycle = kernel
    .get("capabilities")
    .require<PluginStateLifecycle>(
      PLUGIN_STATE_LIFECYCLE_CAPABILITY,
      "cad:active-operations",
    );
  const event = {
    reason: "disable",
    previous: {
      id: "bundled__kenfutwork-cad",
      name: "kenfutwork-cad",
      enabled: true,
    },
    current: null,
  } as PluginStateRevokingEvent;
  lifecycle.afterStateChanged?.({
    reason: "restore",
    previous: null,
    current: event.previous,
  });
  const frozen = registry.captureContributions("code");
  const resolution = {
    preset: "code" as const,
    backendFactory: (() => ({})) as never,
    scopeHandle: task.context.scopeHandle,
    frozenContributions: frozen,
  };
  const tool = registry
    .resolveRunTools(resolution)
    .find((entry) => entry.name === "cad_create_primitive");
  if (!tool) throw new Error("实际 CAD 动态注册未出现");
  try {
    const outcome = Promise.allSettled([
      registry.executeDefinition(
        tool,
        { kind: "sphere", radius: 2 },
        {
          ...task.context,
          frozenContributions: frozen,
          codeApproval: {
            ceiling: "build",
            resolve: async () => ({
              mode: "build",
              scopeGeneration: task.scope.generation,
              branchGeneration: 1,
            }),
          },
        },
      ),
    ]);
    await vi.waitFor(() =>
      expect(
        permissions.listPending(task.scope.instanceId, task.scope.taskId),
      ).toHaveLength(1),
    );
    const pending = permissions.listPending(
      task.scope.instanceId,
      task.scope.taskId,
    )[0];
    if (!pending) throw new Error("实际权限服务未生成待审批操作");
    await lifecycle.onStateRevoking?.(event);
    expect(registry.resolveRunTools(resolution)).toEqual([]);
    lifecycle.afterStateChanged?.({
      reason: "enable",
      previous: event.previous,
      current: event.previous,
    });
    expect(registry.resolveRunTools(resolution)).toEqual([]);
    expect(
      registry
        .resolveRunTools({
          ...resolution,
          frozenContributions: registry.captureContributions("code"),
        })
        .map((entry) => entry.name),
    ).toContain("cad_create_primitive");
    await permissions.resolve({
      interactionId: pending.interaction.interactionId,
      binding: pending.identity,
      answer: { optionId: "allowOnce" },
    });
    expect((await outcome)[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/注册|schema|能力/),
      }),
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await kernel.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
