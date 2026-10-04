import { join } from "node:path";
import { workspaceSettingsSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { composePlugins } from "../../kernel/compose.js";
import type { AdminService } from "../admin/admin-service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createMcpPlugin } from "./plugin.js";
import { deferred, type stdioSandbox } from "./test-stdio-process.js";
import { taskMcpFixture } from "./test-task-mcp-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(options: Parameters<typeof stdioSandbox>[0] = {}) {
  const f = await taskMcpFixture(options, (cleanup) => {
    cleanups.push(cleanup);
  });
  const runner: PostgresQueryRunner = {
    query: async () => ({ rowCount: 0, rows: [] }),
    acquire: async () => ({
      query: async () => ({ rowCount: 0, rows: [] }),
      release() {},
    }),
    acquireSession: async () => {
      throw new Error("MCP接线夹具不建立真实PG宿主会话。");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  const app = Fastify();
  cleanups.push(() => app.close());
  const sandbox = createProcessSandbox({
    captureRoot: join(f.root, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("测试结束"));
  const unused = async (): Promise<never> => {
    throw new Error("此MCP夹具不消费平台管理业务。");
  };
  const admin: AdminService = {
    isAdmin: async () => true,
    requireAdmin: async () => {},
    listUsers: unused,
    platformUsage: unused,
    grantCredits: unused,
    setRole: unused,
    setPlan: unused,
  };
  const kernel = composePlugins(
    {
      agentBackendMode: "state",
      agentModel: "fixture",
      port: 0,
      version: "1",
      webOrigin: "http://localhost",
      sandboxRoot: f.root,
    },
    [createMcpPlugin()],
    {
      app,
      overrides: {
        tools: f.registry,
        auth: { authenticate: async () => f.actor },
        admin,
        persistence,
        processSandbox: { ...sandbox, spawnStdio: f.sandbox.spawnStdio },
        executionScopes: f.scopes,
        settings: {
          onUpdated: () => () => {},
          getWorkspaceSettings: async () =>
            workspaceSettingsSchema.parse({
              defaultModel: "fixture",
              processMaxOutputBytes: 4096,
            }),
          updateWorkspaceSettings: unused,
        },
        taskWork: createTaskWorkManager({
          store: createTaskWorkStore(persistence),
          executionHostId: "mcp-public-test",
          resolveMaxConcurrent: async () => 1,
        }),
      },
    },
  );
  cleanups.push(() => kernel.dispose());
  await app.ready();
  return { ...f, kernel, app };
}

it("MCP真实插件入口按Design/Code一处分派，Code创建接共同Harness与Task前close capability", async () => {
  const f = await fixture();
  const code = f.registry.resolveRunTools(f.resolution());
  const creator = code.find((entry) => entry.name === "create_mcp_server");
  if (!creator) throw new Error("Code MCP创建入口没有接线。");
  expect(
    code.filter((entry) => entry.name === "create_mcp_server"),
  ).toHaveLength(1);
  expect(creator.scope).toBe("code");
  const design = f.registry.resolveRunTools({
    ...f.resolution(),
    preset: "design",
    scopeHandle: undefined,
  });
  expect(
    design.filter((entry) => entry.name === "create_mcp_server"),
  ).toHaveLength(1);
  expect(
    design.find((entry) => entry.name === "create_mcp_server")?.scope,
  ).toBe("design");
  expect(
    await f.registry.executeDefinition(
      creator,
      { name: "owned", path: "server.mjs", env: { USER_TOKEN: "private" } },
      f.context,
    ),
  ).toMatchObject({ status: "connected", envKeys: ["USER_TOKEN"] });
  const closures = f.kernel
    .get("capabilities")
    .list<{ close: (workspaceId: string, taskId: string) => Promise<void> }>(
      "task-before-process-close",
    );
  const close = closures.find(
    (registration) => registration.id === "mcp:task-connections",
  );
  if (!close) throw new Error("MCP Task资源未登记关闭能力。");
  await close.value.close(f.scope.workspaceId, f.scope.taskId);
  expect(f.children[0]?.process.snapshot().exit?.rangeEmpty).toBe(true);
  expect(
    f.registry
      .resolveRunTools(f.resolution())
      .some((entry) => entry.name.startsWith("mcp__task_")),
  ).toBe(false);
});

it("Kernel卸载MCP等待真实stdio stop，不以同步disposer/客户端close假结束", async () => {
  const stopGate = deferred<void>();
  const f = await fixture({ stopGate: stopGate.promise });
  const installer = f.registry
    .resolveRunTools(f.resolution())
    .find((entry) => entry.name === "install_mcp_server");
  if (!installer) throw new Error("MCP安装入口未接线。");
  await f.registry.executeDefinition(
    installer,
    { name: "unload", command: "node" },
    { ...f.context, toolCallId: "install" },
  );
  let disposed = false;
  const disposing = f.kernel.dispose().then(() => {
    disposed = true;
  });
  await f.children[0]?.stopEntered.promise;
  expect(disposed).toBe(false);
  stopGate.resolve();
  await disposing;
  expect(f.children[0]?.process.snapshot().exit?.rangeEmpty).toBe(true);
});

it("保留现有MCP管理HTTP读取接口，CodeTask安装不写全局配置", async () => {
  const f = await fixture();
  expect(
    (await f.app.inject({ method: "GET", url: "/api/mcp/servers" })).json(),
  ).toEqual({ servers: [] });
  const installer = f.registry
    .resolveRunTools(f.resolution())
    .find((entry) => entry.name === "install_mcp_server");
  if (!installer) throw new Error("MCP安装入口未接线。");
  await f.registry.executeDefinition(
    installer,
    { name: "task-local", command: "node" },
    { ...f.context, toolCallId: "install" },
  );
  expect(
    (await f.app.inject({ method: "GET", url: "/api/mcp/servers" })).json(),
  ).toEqual({ servers: [] });
});
