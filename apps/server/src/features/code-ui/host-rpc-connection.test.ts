import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kfw-host-rpc-"));
  cleanups.push(async () => {
    await (await import("node:fs/promises")).rm(directory, {
      recursive: true,
      force: true,
    });
  });
  const instance = createCodeUiTestInstance(randomUUID(), null, directory);
  const service = new CodeUiService({
    localInstance: instance.localInstance,
    repository: {
      preparations: { recover: async () => {} },
      recoverRuntimeInputs: async () => {},
      listRoots: async () => [],
      readHumanPreferences: async () => ({}),
      updateHumanPreferences: async () => true,
    },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
    modelProviders: {
      readCredential: async () => null,
      listInstances: async () => [],
      listProviderPresets: () => [],
      createInstance: async () => {
        throw new Error("host-rpc 测试不覆盖实例写入");
      },
      updateInstance: async () => {
        throw new Error("host-rpc 测试不覆盖实例写入");
      },
      deleteInstance: async () => {
        throw new Error("host-rpc 测试不覆盖实例写入");
      },
    },
    modelCatalog: { listCatalog: async () => [] },
    taskWork: { initialize: async () => [] },
    projects: { listProjects: async () => [] },
    executionScopes: {
      openTask: async () => {
        throw new Error("host-rpc 测试不打开执行作用域");
      },
    },
    env: {},
  } as unknown as CodeUiServiceDeps);
  cleanups.push(() => service.closeConnections());
  const connection = await service.openConnection(
    instance.actor,
    async () => {},
    () => {},
  );
  const app = Fastify();
  await registerCodeUiRoutes(app, {
    service,
    localAccess: { authenticate: async () => instance.actor },
  });
  cleanups.push(() => app.close());
  const rpc = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/code-ui/rpc", payload });
  return { actor: instance.actor, connection, rpc };
}

it("空 connectionId 视为未绑定：connection-less 读取照常返回，不误报连接丢失", async () => {
  const f = await fixture();
  const view = await f.rpc({
    service: "providerSettingsService",
    method: "getView",
    args: [],
    connectionId: "",
  });
  expect(view.statusCode).toBe(200);
  expect(view.json().result).toMatchObject({ revision: expect.any(Number) });
  const selection = await f.rpc({
    service: "modelSelectionService",
    method: "getView",
    args: [null],
    connectionId: "",
  });
  expect(selection.statusCode).toBe(200);
});

it("伪造的陈旧 connectionId 仍然 404，连接所有权守卫不放宽", async () => {
  const f = await fixture();
  const response = await f.rpc({
    service: "providerSettingsService",
    method: "getView",
    args: [],
    connectionId: randomUUID(),
  });
  expect(response.statusCode).toBe(404);
});

it("活连接的有效 connectionId 正常访问", async () => {
  const f = await fixture();
  const response = await f.rpc({
    service: "providerSettingsService",
    method: "getView",
    args: [],
    connectionId: f.connection.hello.connectionId,
  });
  expect(response.statusCode).toBe(200);
});
