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

async function fixture(preset: "code" | "design" = "code") {
  const temporary = await mkdtemp(join(tmpdir(), "kfw-kernel-approval-"));
  const stored: StoredExecutionScope = {
    preset: "code",
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
    workContext: { preset },
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
    scope: preset,
    access: "write",
    description: "write",
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    execute: async (args) => {
      writes += 1;
      return args;
    },
  };
  const unregister = registry.register(tool);
  return {
    unregister,
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
    f.registry.register(control);
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

it("规划控制不能被worker/explore/review或资源access借用", async () => {
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
    await expect(f.registry.executeDefinition(control, {}, {})).rejects.toThrow(
      /规划控制/,
    );
    expect(executed).toBe(0);
  } finally {
    await f.close();
  }
});

it.each(["code", "design"] as const)(
  "%s Run的主Task可执行真实注册shared规划控制，不能授予资源写权限",
  async (preset) => {
    const f = await fixture(preset);
    let controls = 0;
    const tool: ToolDefinition = {
      name: "SharedEnterPlanMode",
      scope: "shared",
      planControl: "enter",
      description: "规划控制",
      parameters: { type: "object" },
      execute: async () => {
        controls += 1;
        return { planEnabled: true };
      },
    };
    const dispose = f.registry.register(tool);
    try {
      expect(f.context.scopeHandle!.preset).toBe("code");
      expect(
        await f.registry.executeDefinition(
          tool,
          {},
          { ...f.context, toolCallId: `shared-control-${preset}` },
        ),
      ).toEqual({ planEnabled: true });
      expect(controls).toBe(1);
      expect(f.writes()).toBe(0);
    } finally {
      dispose();
      await f.close();
    }
  },
);

it.each(["code", "design"] as const)(
  "真实%s Task仅执行匹配模式与共享工具，拒绝另一模式",
  async (preset) => {
    const f = await fixture(preset);
    try {
      const calls: string[] = [];
      const probe = (
        name: string,
        scope: "code" | "design" | "shared",
      ): ToolDefinition => ({
        name,
        scope,
        access: "read",
        description: "read task state",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          calls.push(name);
          return name;
        },
      });
      f.registry.register(probe("MatchingRead", preset));
      f.registry.register(
        probe("OtherRead", preset === "code" ? "design" : "code"),
      );
      f.registry.register(probe("SharedRead", "shared"));
      await expect(
        f.registry.execute("OtherRead", {}, f.context),
      ).rejects.toThrow("工具模式与当前Task不匹配");
      expect(calls).toEqual([]);
      await expect(
        f.registry.execute("MatchingRead", {}, f.context),
      ).resolves.toBe("MatchingRead");
      await expect(
        f.registry.execute(
          "SharedRead",
          {},
          { ...f.context, toolCallId: "shared-call" },
        ),
      ).resolves.toBe("SharedRead");
      expect(calls).toEqual(["MatchingRead", "SharedRead"]);
      expect(
        f.permissions.listPending(
          f.stored.scope.instanceId,
          f.stored.scope.taskId,
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("Design Run沿Code Task执行共享Write与同一审批，不能调用Code专属工具", async () => {
  const f = await fixture("design");
  try {
    let invokedPreset: string | undefined;
    f.bus.on("tool-pre-execute", async (payload, next) => {
      invokedPreset = payload.permissionInvocation?.preset;
      return next(payload);
    });
    f.unregister();
    const sharedTool: ToolDefinition = { ...f.tool, scope: "shared" };
    f.registry.register(sharedTool);
    expect(
      await f.registry.executeDefinition(
        sharedTool,
        { content: " design " },
        f.context,
      ),
    ).toEqual({ content: "design", suffix: "!" });
    expect(invokedPreset).toBe("design");
    expect(f.writes()).toBe(1);
    const codeControl: ToolDefinition = {
      ...f.tool,
      scope: "code",
      name: "EnterPlanMode",
      access: undefined,
      planControl: "enter",
    };
    const removeControl = f.registry.register(codeControl);
    try {
      await expect(
        f.registry.executeDefinition(
          codeControl,
          { content: "control" },
          f.context,
        ),
      ).rejects.toThrow(/工具模式/);
    } finally {
      removeControl();
    }
    const codeTool: ToolDefinition = {
      ...f.tool,
      name: "CodeOnlyWrite",
      scope: "code",
    };
    f.registry.register(codeTool);
    await expect(
      f.registry.executeDefinition(
        codeTool,
        { content: "wrong mode" },
        f.context,
      ),
    ).rejects.toThrow(/工具模式/);
  } finally {
    await f.close();
  }
});
