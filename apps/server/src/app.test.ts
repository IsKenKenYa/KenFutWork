import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { KenFutWorkAgentFactory } from "./agent/deep-agent.js";
import type { AgentRuntimeProvider } from "./agent/provider-contract.js";
import { buildApp } from "./app.js";
import { createExecutionScopes } from "./features/execution/scope-service.js";
import type { ProjectDirectoryRelinkService } from "./features/projects/directory-relink.js";
import { createTaskWorkManager } from "./features/task-work/service.js";
import {
  createMemoryTaskWorkManager,
  createMemoryTaskWorkStore,
} from "./features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "./test-startup-persistence.js";

/**
 * buildApp 装配完整性回归：所有 feature 插件的认证门路由必须真实注册。
 * 用未授权请求探针：401 = 路由已注册且过本机接入门；404 = 插件漏挂载。
 * 背景：P3 迁移中曾出现「路由手工注册已删、插件却未接入内核清单」的静默漏挂载，
 * 本机功能必须真实挂载；退役账户和商业功能必须返回 404。
 */
const AUTH_GATED_PROBES = [
  { method: "GET", url: "/api/brand-kits" },
  { method: "GET", url: "/api/jobs" },
  { method: "GET", url: "/api/projects" },
  { method: "GET", url: "/api/skills" },
  { method: "GET", url: "/api/instance/skills" },
  { method: "GET", url: "/api/instance" },
  {
    method: "POST",
    url: "/api/agent/runs",
    payload: {
      sessionId: "session-1",
      conversationId: "conversation-1",
      prompt: "hello",
    },
  },
  { method: "GET", url: "/api/instance/settings" },
  { method: "GET", url: "/api/local-access/clients" },
  { method: "GET", url: "/api/models" },
  { method: "GET", url: "/api/provider-instances" },
  { method: "GET", url: "/api/model-catalog" },
  { method: "GET", url: "/api/usage/summary" },
] as const;

const RETIRED_PROBES = [
  { method: "GET", url: "/api/viewer" },
  { method: "GET", url: "/api/credits" },
  { method: "POST", url: "/api/auth/login" },
  { method: "POST", url: "/api/auth/register" },
  { method: "GET", url: "/api/payments/plans" },
  { method: "GET", url: "/api/admin/me" },
  { method: "GET", url: "/api/admin/users" },
  { method: "GET", url: "/api/admin/usage" },
  { method: "GET", url: "/api/admin/providers" },
] as const;

/** 无认证门但必须装配的路由（注册完整性用 200 探针）。 */
const PUBLIC_GET_ROUTES = ["/api/health"] as const;

function buildProbeApp(projectDirectoryRelink?: ProjectDirectoryRelinkService) {
  const persistence = createStartupPersistenceFixture();
  return buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/kenfutwork-test",
      // blob 缝是必需能力且只有本地 FS 形态（M1.5 已删 Supabase Provider）
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      desktopDataDir: persistence.dataDir,
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence,
      ...(projectDirectoryRelink ? { projectDirectoryRelink } : {}),
    },
  });
}

function buildRuntimeProbeApp(
  options: {
    runtimeProvider?: AgentRuntimeProvider;
    agentFactory?: KenFutWorkAgentFactory;
  } = {},
) {
  const persistence = createStartupPersistenceFixture();
  const taskPolicies = new Map<
    string,
    { instanceId: string; accessClientId: string | null; policy: object }
  >();
  const taskWorkStore = createMemoryTaskWorkStore();
  const taskWork = createTaskWorkManager({
    store: taskWorkStore,
    executionHostId: randomUUID(),
    resolveMaxConcurrent: async () =>
      AGENT_GOVERNANCE_DEFAULTS.subagentMaxConcurrency,
  });
  const app = buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/kenfutwork-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      desktopDataDir: persistence.dataDir,
    },
    ...options,
    overrides: {
      taskWork,
      persistence,
      modelCatalog: { listCatalog: async () => [] } as never,
      designTasks: {
        readPolicy: async (
          actor: { instanceId: string; accessClientId: string | null },
          taskId: string,
        ) => {
          const entry = taskPolicies.get(taskId);
          if (
            !entry ||
            entry.instanceId !== actor.instanceId ||
            entry.accessClientId !== actor.accessClientId
          )
            throw new Error("测试 Design Task scope 不匹配。");
          return entry.policy;
        },
        recoverInterruptedTasks: async () => 0,
        onLeaseLost: () => () => {},
        close: async () => {},
      } as never,
      designGoals: {
        initialize: async () => {},
        close: async () => {},
        onLost: () => () => {},
        readTask: async () => null,
        read: async () => null,
        verify: async () => {
          throw new Error("NoGoal Provider probe cannot verify goal evidence.");
        },
        observe: async () => ({ stop: false }),
        continuation: async () => null,
      } as never,
    },
  });
  return {
    app,
    async openDesignTask(actor: {
      instanceId: string;
      accessClientId: string | null;
    }) {
      const localInstance = app.kernel.get("localInstance");
      const instance = await localInstance.getContext();
      const scope: CodeExecutionScope = {
        instanceId: actor.instanceId,
        projectId: randomUUID(),
        taskId: randomUUID(),
        generation: 0,
        rootDirectory: await realpath(instance.dataDir),
        additionalDirectories: [],
        sandboxMode: "workspace-write",
      };
      const scopes = createExecutionScopes({
        repository: {
          load: async (instanceId, taskId) =>
            instanceId === scope.instanceId && taskId === scope.taskId
              ? {
                  preset: "design",
                  scope,
                  state: "ready",
                  branchGeneration: 1,
                }
              : null,
        },
        localInstance,
      });
      const handle = await scopes.openTask(actor, scope.taskId);
      taskPolicies.set(scope.taskId, {
        instanceId: actor.instanceId,
        accessClientId: actor.accessClientId,
        policy: {
          mode: "build",
          planEnabled: false,
          planningEpoch: 0,
          scopeGeneration: scope.generation,
          branchGeneration: handle.branchGeneration,
        },
      });
      taskWorkStore.setTask({
        actor,
        ownerKind: "design",
        scope: handle.describe(),
        agentId: handle.agentId,
        runId: "provider-probe-setup",
        branchGeneration: handle.branchGeneration,
      });
      return handle;
    },
  };
}

async function streamRuntimeProbe(
  probe: ReturnType<typeof buildRuntimeProbeApp>,
) {
  const { app } = probe;
  await app.ready();
  const localAccess = app.kernel.get("localAccess");
  const token = await localAccess.getDesktopToken();
  const actor = await localAccess.authenticate({
    ip: "127.0.0.1",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!actor) throw new Error("测试桌面接入身份不可用。");
  const scopeHandle = await probe.openDesignTask(actor);
  const scope = scopeHandle.describe();
  const runtime = app.kernel.get("agentRuns");
  const { runId } = runtime.createRun(
    {
      sessionId: scope.taskId,
      conversationId: scope.taskId,
      taskId: scope.taskId,
      projectId: scope.projectId,
      prompt: "provider wiring probe",
      preset: "design",
    },
    { actor, scopeHandle },
  );
  const events = [];
  for await (const event of runtime.streamRun(runId)) events.push(event);
  return events;
}

describe("buildApp 装配完整性（插件清单防漏挂）", () => {
  it("全部本机 feature 路由已装配且拒绝无凭据请求", async () => {
    const app = buildProbeApp();
    try {
      for (const probe of AUTH_GATED_PROBES) {
        const response = await app.inject(probe);
        expect(
          response.statusCode,
          `${probe.method} ${probe.url} 未通过本机接入门`,
        ).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("账户、管理员与商业路由均已退役", async () => {
    const app = buildProbeApp();
    try {
      await app.ready();
      const token = await app.kernel.get("localAccess").getDesktopToken();
      for (const probe of RETIRED_PROBES) {
        const response = await app.inject({
          ...probe,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, `${probe.method} ${probe.url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("缺 databaseUrl 时启动期 fail loud（存储缝是必需项，不再静默降级）", () => {
    // 本例断言「未配置即失败」，故必须屏蔽进程环境里可能存在的连接串：
    // 集成测试会带着 DATABASE_URL 跑整套用例，否则这里会因环境泄漏假失败。
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("KENFUTWORK_DATABASE_URL", "");
    try {
      expect(() =>
        buildApp({
          // blob 配置给全，让「缺 databaseUrl」成为唯一的失败原因
          env: {
            blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
          },
          overrides: {
            taskWork: createMemoryTaskWorkManager(),
          },
        }),
      ).toThrow(/persistence/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("公开路由不设认证门但必须装配：200 而非 404", async () => {
    const app = buildProbeApp();
    try {
      for (const url of PUBLIC_GET_ROUTES) {
        const response = await app.inject({ method: "GET", url });
        expect(
          response.statusCode,
          `${url} 未按预期装配（期望 200，实际 ${response.statusCode}）`,
        ).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("flow 网关回调自带共享密钥门：跳过本机接入总门（未配密钥 503），宿主前端换票仍走本机门（401）", async () => {
    const app = buildProbeApp();
    try {
      for (const probe of [
        {
          method: "POST",
          url: "/api/flow/host/identity",
          payload: { token: "forged" },
        },
        { method: "POST", url: "/api/flow/host/credentials", payload: {} },
        {
          method: "POST",
          url: "/api/flow/host/events",
          payload: { events: [] },
        },
      ] as const) {
        const response = await app.inject(probe);
        // 未配 KENFUTWORK_FLOW_EMBED_SECRET：路由自己的门回 503；
        // 若仍被本机接入总门拦住会是 401（历史回归：合并后网关侧三条路由全被总门拦死）。
        expect(response.statusCode, `${probe.url}`).toBe(503);
      }
      const ticket = await app.inject({
        method: "POST",
        url: "/api/flow/host/identity-ticket",
        payload: {},
      });
      expect(ticket.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("buildApp AgentRuntimeProvider bridge", () => {
  it("passes the configured Provider into the real Runtime stream", async () => {
    const open = vi.fn(
      (context: Parameters<AgentRuntimeProvider["open"]>[0]) => ({
        stream: () =>
          (async function* () {
            yield {
              type: "run.started" as const,
              runId: context.runId,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              timestamp: "2026-10-12T00:00:00.000Z",
            };
            yield {
              type: "run.completed" as const,
              runId: context.runId,
              timestamp: "2026-10-12T00:00:01.000Z",
              stopReason: "completed" as const,
            };
          })(),
      }),
    );
    const runtimeProvider: AgentRuntimeProvider = { id: "probe", open };
    const probe = buildRuntimeProbeApp({ runtimeProvider });
    try {
      const events = await streamRuntimeProbe(probe);
      expect(open).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "run.completed")).toBe(true);
      expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
    } finally {
      await probe.app.close();
    }
  });

  it("keeps the default DeepAgents Provider when no Provider is configured", async () => {
    const agentFactory = vi.fn(
      () =>
        ({
          stream: async function* () {},
          streamEvents: async function* () {},
        }) as never,
    );
    const probe = buildRuntimeProbeApp({ agentFactory });
    try {
      const events = await streamRuntimeProbe(probe);
      expect(agentFactory).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "run.completed")).toBe(true);
      expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
    } finally {
      await probe.app.close();
    }
  });
});

describe("directory recovery startup barrier", () => {
  it("registers routes before ready and waits for persisted recovery initialization", async () => {
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restore: ProjectDirectoryRelinkService = {
      initialize: async () => {
        begin();
        await blocked;
      },
      snapshot: async () => {
        throw new Error("unused probe");
      },
      relink: async () => {
        throw new Error("unused probe");
      },
    };
    const app = buildProbeApp(restore);
    let ready = false;
    const startup = app.ready().then(() => {
      ready = true;
    });
    try {
      await begun;
      expect(
        app.hasRoute({
          method: "GET",
          url: "/api/projects/:projectId/relink-directory",
        }),
      ).toBe(true);
      expect(ready).toBe(false);
      release();
      await startup;
      expect(ready).toBe(true);
    } finally {
      release();
      await startup;
      await app.close();
    }
  });
  it("fails app readiness when the durable recovery query fails", async () => {
    const restore: ProjectDirectoryRelinkService = {
      initialize: async () => {
        throw new Error("durable directory recovery unavailable");
      },
      snapshot: async () => {
        throw new Error("unused probe");
      },
      relink: async () => {
        throw new Error("unused probe");
      },
    };
    const app = buildProbeApp(restore);
    try {
      await expect(app.ready()).rejects.toThrow(
        "durable directory recovery unavailable",
      );
    } finally {
      await app.close();
    }
  });
});
