import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import type { StoredExecutionScope } from "../features/execution/scope-repository.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createPermissionService } from "../features/permissions/permission-service.js";
import { AgentRunEventBus, ToolRegistryImpl } from "./context.js";
import type { ToolDefinition, ToolExecutionContext } from "./types.js";

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "kfw-kernel-approval-"));
  const stored: StoredExecutionScope = {
    state: "ready",
    branchGeneration: 1,
    scope: {
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 1,
      rootDirectory: await realpath(temporary),
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    },
  };
  const scope = await createExecutionScopes({
    repository: { load: async () => structuredClone(stored) },
    localInstance: {
      resolve: async () => ({
        instanceId: stored.scope.instanceId,
        dataDir: temporary,
      }),
    } as never,
  }).openTask(
    { instanceId: stored.scope.instanceId, accessClientId: null },
    stored.scope.taskId,
  );
  const permissions = createPermissionService();
  const bus = new AgentRunEventBus();
  bus.on("tool-pre-execute", async (payload, next) => {
    if (!payload.permissionInvocation) return next(payload);
    const result = await permissions.admit(payload.permissionInvocation);
    return next({
      ...payload,
      decision: result.decision,
      ...(result.reason ? { denyReason: result.reason } : {}),
    });
  });
  permissions.onEvent(async (event) => {
    if (event.type === "requested")
      await permissions.resolve({
        interactionId: event.interaction.interactionId,
        answer: { action: "accept" },
        binding: event.identity,
      });
  });
  const registry = new ToolRegistryImpl(bus, () => permissions);
  const context: ToolExecutionContext = {
    scopeHandle: scope,
    actor: { instanceId: stored.scope.instanceId, accessClientId: null },
    runId: "run",
    toolCallId: "call",
    codeApproval: {
      ceiling: "build",
      resolve: async () => ({
        mode: "build",
        scopeGeneration: stored.scope.generation,
        branchGeneration: stored.branchGeneration,
      }),
    },
  };
  let writes = 0;
  const schema = z
    .object({ content: z.string().trim(), suffix: z.string().default("!") })
    .strict();
  const tool: ToolDefinition = {
    name: "Write",
    scope: "code",
    access: "write",
    description: "write",
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    execute: async (args) => {
      writes += 1;
      return args;
    },
  };
  return {
    bus,
    registry,
    context,
    tool,
    permissions,
    stored,
    writes: () => writes,
    close: () => rm(temporary, { recursive: true, force: true }),
  };
}

it("真实工具schema规范化后逐调用审批，最终只执行一次", async () => {
  const f = await fixture();
  try {
    const approvedArgs: unknown[] = [];
    f.bus.on("tool-pre-execute", async (payload, next) => {
      approvedArgs.push(payload.permissionInvocation?.args);
      return next(payload);
    });
    expect(
      await f.registry.executeDefinition(
        f.tool,
        { content: " hello " },
        f.context,
      ),
    ).toEqual({ content: "hello", suffix: "!" });
    await expect(
      f.registry.executeDefinition(f.tool, { content: " hello " }, f.context),
    ).rejects.toThrow(/拒绝/);
    expect(approvedArgs[0]).toEqual({ content: "hello", suffix: "!" });
    expect(f.writes()).toBe(1);
  } finally {
    await f.close();
  }
});

it("后续waterfall拒绝不消耗已绑定的一次审批", async () => {
  const f = await fixture();
  try {
    const off = f.bus.on("tool-pre-execute", async (payload) => ({
      ...payload,
      decision: "deny",
      denyReason: "later policy",
    }));
    await expect(
      f.registry.executeDefinition(f.tool, { content: "hello" }, f.context),
    ).rejects.toThrow(/later policy/);
    off();
    expect(
      await f.registry.executeDefinition(
        f.tool,
        { content: "hello" },
        f.context,
      ),
    ).toEqual({ content: "hello", suffix: "!" });
    expect(f.writes()).toBe(1);
  } finally {
    await f.close();
  }
});

it("等待审批期间branch改变拒绝迟到执行", async () => {
  const f = await fixture();
  try {
    f.bus.on("tool-pre-execute", async (payload, next) => {
      f.stored.branchGeneration += 1;
      return next(payload);
    });
    await expect(
      f.registry.executeDefinition(f.tool, { content: "hello" }, f.context),
    ).rejects.toThrow(/分支|代际/);
    expect(f.writes()).toBe(0);
  } finally {
    await f.close();
  }
});

it("主Task规划控制能在真实只读scope调用且不授予资源write，claim只能消费一次", async () => {
  const f = await fixture();
  try {
    f.stored.scope.sandboxMode = "read-only";
    let entered = 0;
    const control: ToolDefinition = {
      name: "EnterPlanMode",
      scope: "code",
      planControl: "enter",
      description: "收紧规划",
      parameters: { type: "object", additionalProperties: false },
      execute: async () => {
        entered += 1;
        return "entered";
      },
    };
    expect(await f.registry.executeDefinition(control, {}, f.context)).toBe(
      "entered",
    );
    expect(
      f.permissions.listPending(
        f.stored.scope.instanceId,
        f.stored.scope.taskId,
      ),
    ).toEqual([]);
    await expect(
      f.registry.executeDefinition(control, {}, f.context),
    ).rejects.toThrow(/拒绝|消费/);
    expect(entered).toBe(1);
    await expect(
      f.registry.executeDefinition(
        f.tool,
        { content: "no" },
        {
          ...f.context,
          toolCallId: "resource-call",
        },
      ),
    ).rejects.toThrow(/只读|拒绝/);
    expect(f.writes()).toBe(0);
  } finally {
    await f.close();
  }
});

it("规划控制不能被worker/explore/review、shared工具或资源access借用", async () => {
  const f = await fixture();
  try {
    let executed = 0;
    const control: ToolDefinition = {
      name: "EnterPlanMode",
      scope: "code",
      planControl: "enter",
      description: "收紧规划",
      parameters: { type: "object" },
      execute: async () => {
        executed += 1;
        return "unexpected";
      },
    };
    for (const role of ["worker", "explore", "review"] as const)
      await expect(
        f.registry.executeDefinition(
          control,
          {},
          {
            ...f.context,
            scopeHandle: f.context.scopeHandle!.derive(role, `agent-${role}`),
          },
        ),
      ).rejects.toThrow(/规划控制|主Code/);
    for (const access of ["read", "write", "execute"] as const)
      await expect(
        f.registry.executeDefinition({ ...control, access }, {}, f.context),
      ).rejects.toThrow(/混合|规划控制/);
    await expect(
      f.registry.executeDefinition(
        { ...control, scope: "shared" },
        {},
        f.context,
      ),
    ).rejects.toThrow(/规划控制/);
    await expect(f.registry.executeDefinition(control, {}, {})).rejects.toThrow(
      /规划控制/,
    );
    expect(executed).toBe(0);
  } finally {
    await f.close();
  }
});
