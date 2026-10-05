import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  instanceSettingsSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { createPluginInventoryFixture } from "./plugins.test-fixture.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(withTargets = false) {
  const actual = await createPluginInventoryFixture();
  cleanups.push(actual.dispose);
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const fixedRoot = join(actual.directory, "fixed-task-root");
  const currentRoot = join(actual.directory, "new-project-default");
  const service = new CodeUiService({
    plugins: actual.registry,
    localInstance: createCodeUiTestInstance(
      actual.instanceId,
      null,
      actual.directory,
    ).localInstance,
    repository: {
      recoverRuntimeInputs: async () => {},
      listRoots: async () => [
        {
          project_id: projectId,
          root_directory: fixedRoot,
          parent_session_id: null,
          deleted_at: null,
        },
      ],
    },
    taskWork: { initialize: async () => [] },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
    projects: {
      listProjects: async () => {
        if (!withTargets) throw new Error("user库存不得读取或创建Project");
        return [
          {
            id: projectId,
            kind: "code",
            name: "目标项目",
            workDir: currentRoot,
            additionalDirectories: [],
          },
          {
            id: otherProjectId,
            kind: "code",
            name: "同目录项目",
            workDir: currentRoot,
            additionalDirectories: [],
          },
        ];
      },
    },
    executionScopes: {
      openTask: async () => {
        throw new Error("user库存不得打开执行作用域");
      },
    },
    env: {},
  } as unknown as CodeUiServiceDeps);
  cleanups.push(() => service.closeConnections());
  const connection = await service.openConnection(
    actual.actor,
    async () => {},
    () => {},
  );
  const app = Fastify();
  await registerCodeUiRoutes(app, {
    service,
    localAccess: { authenticate: async () => actual.actor },
  });
  cleanups.push(() => app.close());
  const rpc = (method: string, value: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/code-ui/rpc",
      payload: {
        service: "plugin-management",
        method,
        args: [value],
        connectionId: connection.hello.connectionId,
      },
    });
  return {
    ...actual,
    service,
    connection,
    rpc,
    projectId,
    fixedRoot,
    currentRoot,
  };
}

it("原plugin-management HTTP消费者读取唯一真实DSH安装库存，机器级读取不创建Project或Task", async () => {
  const f = await fixture();
  const { installed } = await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  await f.registry.setEnabled(installed.id, false);
  const list = await f.rpc("listPlugins", { configScope: "user" });
  expect(list.statusCode).toBe(200);
  expect(
    zcodePluginsListResultSchema.parse(list.json().result).plugins,
  ).toMatchObject([
    { id: installed.id, name: "kenfutwork-example-clock", enabled: false },
  ]);
  const overview = await f.rpc("getPluginsOverview", { configScope: "user" });
  expect(overview.statusCode).toBe(200);
  expect(
    zcodePluginsOverviewResultSchema.parse(overview.json().result)
      .installedPlugins,
  ).toMatchObject([{ id: installed.id, enabled: false, scope: "user" }]);
});

it("原插件两读HTTP在库存损坏时给真实宿主错误，不发空库存或覆写原文件", async () => {
  const f = await fixture();
  await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  const statePath = join(f.directory, "plugins", "installed.json");
  await writeFile(statePath, "{");
  for (const method of ["listPlugins", "getPluginsOverview"]) {
    const response = await f.rpc(method, { configScope: "user" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: "code_ui_error",
        message: expect.stringContaining("插件库存损坏"),
      },
    });
    expect(response.json()).not.toHaveProperty("result");
  }
  expect(await readFile(statePath, "utf8")).toBe("{");
});

it("库存目标走真实Project与Task固定根解析，同目录歧义或伪造identity不授予读取", async () => {
  const f = await fixture(true);
  const fixed = await f.rpc("getPluginsOverview", {
    configScope: "user",
    workspacePath: f.fixedRoot,
    projectId: f.projectId,
    workspaceIdentity: JSON.stringify([f.projectId, f.fixedRoot]),
  });
  expect(fixed.statusCode).toBe(200);
  expect(
    zcodePluginsOverviewResultSchema.parse(fixed.json().result)
      .availablePlugins,
  ).toMatchObject([{ id: f.bundled.id }]);
  const ambiguous = await f.rpc("listPlugins", {
    configScope: "user",
    workspacePath: f.currentRoot,
  });
  expect(ambiguous.statusCode).toBe(409);
  const forged = await f.rpc("listPlugins", {
    workspacePath: f.fixedRoot,
    projectId: f.projectId,
    workspaceIdentity: JSON.stringify([randomUUID(), f.fixedRoot]),
  });
  expect(forged.statusCode).toBe(404);
  const absentSource = await f.rpc("listPlugins", {
    workspacePath: join(f.directory, "unknown"),
    projectId: f.projectId,
  });
  expect(absentSource.statusCode).toBe(404);
});

it("原安装HTTP消费管理员能力与真实Project元信息，真实安装结果和唯一库存一致", async () => {
  const f = await fixture(true);
  const response = await f.rpc("installPlugin", {
    workspacePath: f.currentRoot,
    projectId: f.projectId,
    workspaceIdentity: JSON.stringify([f.projectId, f.currentRoot]),
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
    scope: "user",
  });
  expect(response.statusCode).toBe(200);
  const result = zcodePluginsInstallResultSchema.parse(response.json().result);
  expect(result.installedPlugins).toMatchObject([
    {
      id: f.bundled.id,
      name: "kenfutwork-example-clock",
      enabled: true,
      scope: "user",
    },
  ]);
  const inventory = await f.rpc("getPluginsOverview", { configScope: "user" });
  expect(
    zcodePluginsOverviewResultSchema.parse(inventory.json().result)
      .installedPlugins,
  ).toEqual(result.installedPlugins);
});

it("实例主人可管理本机插件，无平台管理员前置条件", async () => {
  const f = await fixture(true);
  const installed = await f.rpc("installPlugin", {
    workspacePath: f.currentRoot,
    projectId: f.projectId,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
    scope: "user",
  });
  expect(installed.statusCode).toBe(200);
  const after = await f.rpc("getPluginsOverview", { configScope: "user" });
  expect(
    zcodePluginsOverviewResultSchema.parse(after.json().result)
      .installedPlugins,
  ).toMatchObject([{ id: f.bundled.id, enabled: true }]);
});

it("原插件HTTP对未装配的项目安装范围给明确400，避免误报宿主故障", async () => {
  const f = await fixture(true);
  const response = await f.rpc("installPlugin", {
    workspacePath: f.currentRoot,
    projectId: f.projectId,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
    scope: "workspace",
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({
    error: {
      code: "invalid_request",
      message: "项目层插件安装或启停尚未接通，请使用本机用户层。",
    },
  });
  const inventory = await f.rpc("getPluginsOverview", { configScope: "user" });
  expect(
    zcodePluginsOverviewResultSchema.parse(inventory.json().result)
      .installedPlugins,
  ).toEqual([]);
});
