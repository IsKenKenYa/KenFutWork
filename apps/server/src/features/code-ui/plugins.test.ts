import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { createCodeUiPluginsHost } from "./plugins.js";
import { createPluginInventoryFixture } from "./plugins.test-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const actual = await createPluginInventoryFixture();
  cleanups.push(actual.dispose);
  const host = createCodeUiPluginsHost({
    registry: actual.registry,
    readWorkspaceId: async (actor) => {
      if (actor.id !== actual.actor.id) throw new Error("工作区身份无效");
      return actual.workspaceId;
    },
    workspace: async () => {
      throw new Error("用户级无目标库存不得读取或创建Project/Task/scope");
    },
  });
  return { ...actual, host, owner: actual.actor };
}

it("原两读RPC从真实bundle与安装态显示停用包，user无Project不创建工作域", async () => {
  const { host, registry, owner, bundled } = await fixture();
  const { installed } = await registry.install({
    builtin: bundled.name,
    allowLifecycleScripts: false,
  });
  await registry.setEnabled(installed.id, false);
  const list = zcodePluginsListResultSchema.parse(
    (await host.call(owner, "listPlugins", { configScope: "user" }))?.result,
  );
  const overview = zcodePluginsOverviewResultSchema.parse(
    (await host.call(owner, "getPluginsOverview", { configScope: "user" }))
      ?.result,
  );
  expect(list.plugins).toMatchObject([
    {
      id: installed.id,
      name: "kenfutwork-example-clock",
      version: "1.0.0",
      enabled: false,
      skillRootCount: 0,
      commandRootCount: 0,
      mcpServerNames: [],
    },
  ]);
  expect(overview.availablePlugins).toMatchObject([
    { id: installed.id, installed: true },
  ]);
  expect(overview.installedPlugins).toMatchObject([
    { id: installed.id, version: "1.0.0", enabled: false, scope: "user" },
  ]);
  expect(list.plugins[0]?.rootPath).toBe(
    overview.installedPlugins[0]?.installPath,
  );
  await expect(host.call(owner, "installPlugin", {})).rejects.toThrow();
});

it("真实机器安装库存损坏时两读RPC明确拒绝且不写假空库存覆盖原文件", async () => {
  const { host, registry, owner, bundled, directory } = await fixture();
  await registry.install({
    builtin: bundled.name,
    allowLifecycleScripts: false,
  });
  const statePath = join(directory, "plugins", "installed.json");
  for (const damaged of [
    "{",
    '{"version":1,"installed":"broken"}',
    '{"version":1,"installed":[{"id":"invalid"}]}',
  ]) {
    await writeFile(statePath, damaged);
    for (const method of ["listPlugins", "getPluginsOverview"]) {
      await expect(
        host.call(owner, method, { configScope: "user" }),
      ).rejects.toThrow("插件库存损坏");
    }
    expect(await readFile(statePath, "utf8")).toBe(damaged);
  }
});

it("首次机器库存ENOENT是真未安装，真实bundle仍可见且读取不生成状态文件", async () => {
  const { host, owner, directory, bundled } = await fixture();
  const list = zcodePluginsListResultSchema.parse(
    (await host.call(owner, "listPlugins", { configScope: "user" }))?.result,
  );
  const overview = zcodePluginsOverviewResultSchema.parse(
    (await host.call(owner, "getPluginsOverview", { configScope: "user" }))
      ?.result,
  );
  expect(list.plugins).toEqual([]);
  expect(overview.availablePlugins).toMatchObject([
    { id: bundled.id, name: "kenfutwork-example-clock", installed: false },
  ]);
  expect(
    overview.availablePlugins.some((entry) =>
      ["Read", "Edit", "agent-runs", "model-providers"].includes(entry.id),
    ),
  ).toBe(false);
  await expect(
    readFile(join(directory, "plugins", "installed.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("无管理员标记的认证用户可读机器库存，陌生actor与给出的Project目标必须验证", async () => {
  const { host, owner } = await fixture();
  expect(
    zcodePluginsListResultSchema.parse(
      (await host.call(owner, "listPlugins", {}))?.result,
    ).plugins,
  ).toEqual([]);
  await expect(
    host.call({ ...owner, id: randomUUID() }, "listPlugins", {
      configScope: "user",
    }),
  ).rejects.toThrow("工作区身份无效");
  await expect(
    host.call(owner, "listPlugins", { configScope: "workspace" }),
  ).rejects.toThrow("真实工作目录");
  await expect(
    host.call(owner, "getPluginsOverview", {
      configScope: "user",
      workspacePath: "/unverified",
      projectId: randomUUID(),
    }),
  ).rejects.toThrow("用户级无目标库存不得读取或创建Project/Task/scope");
});

it("未知remoteSession和畸形请求不签权限，未装配写方法保持unsupported且不落安装态", async () => {
  const { host, owner, directory } = await fixture();
  await expect(
    host.call(owner, "listPlugins", {
      configScope: "user",
      remoteSessionId: "unknown",
    }),
  ).rejects.toThrow("未装配远程");
  await expect(
    host.call(owner, "listPlugins", { configScope: "invalid" }),
  ).rejects.toThrow();
  await expect(host.call(owner, "installPlugin", {})).rejects.toThrow();
  await expect(host.call(owner, "setPluginEnabled", {})).rejects.toThrow();
  expect(await host.call(owner, "uninstallPlugin", {})).toBeNull();
  await expect(
    readFile(join(directory, "plugins", "installed.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
