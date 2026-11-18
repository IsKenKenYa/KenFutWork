import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  zcodePluginsInstallResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { createPluginManagementFixture } from "./plugins.test-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const actual = await createPluginManagementFixture();
  cleanups.push(actual.dispose);
  return actual;
}

it("原installPlugin只接受实例主人本机自带包，dryRun不落盘且workspace范围明确拒绝", async () => {
  const f = await fixture();
  const input = {
    ...f.target,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
    scope: "user",
  };
  const preview = zcodePluginsInstallResultSchema.parse(
    (await f.host.call(f.actor, "installPlugin", { ...input, dryRun: true }))
      ?.result,
  );
  expect(preview).toMatchObject({
    installedPlugins: [],
    dependencyClosure: [],
  });
  expect(
    zcodePluginsOverviewResultSchema.parse(
      (await f.host.call(f.actor, "getPluginsOverview", {}))?.result,
    ).installedPlugins,
  ).toEqual([]);
  await expect(
    readFile(join(f.directory, "plugins", "installed.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    f.host.call(f.foreignActor, "installPlugin", input),
  ).rejects.toMatchObject({
    code: "instance_forbidden",
    statusCode: 403,
  });
  await expect(
    f.host.call(f.actor, "installPlugin", { ...input, scope: "workspace" }),
  ).rejects.toThrow("项目层插件");
  const result = zcodePluginsInstallResultSchema.parse(
    (await f.host.call(f.actor, "installPlugin", input))?.result,
  );
  expect(result.installedPlugins).toMatchObject([
    { id: f.bundled.id, name: f.bundled.name, enabled: true, scope: "user" },
  ]);
  const overview = zcodePluginsOverviewResultSchema.parse(
    (await f.host.call(f.actor, "getPluginsOverview", {}))?.result,
  );
  expect(overview.availablePlugins).toMatchObject([
    { id: f.bundled.id, installed: true },
  ]);
  expect(overview.installedPlugins).toMatchObject(result.installedPlugins);
  await f.registry.setEnabled(f.bundled.id, false);
  const reinstalled = zcodePluginsInstallResultSchema.parse(
    (await f.host.call(f.actor, "installPlugin", input))?.result,
  );
  expect(reinstalled.installedPlugins).toMatchObject([
    { id: f.bundled.id, enabled: false },
  ]);
});
