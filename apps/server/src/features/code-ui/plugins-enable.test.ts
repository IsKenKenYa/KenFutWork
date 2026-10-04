import {
  zcodePluginsOverviewResultSchema,
  zcodePluginsSetEnabledResultSchema,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { createPluginManagementFixture } from "./plugins.test-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("原setPluginEnabled持久停用并收回真实工具，恢复启用仍执行原包且不授权workspace范围", async () => {
  const f = await createPluginManagementFixture();
  cleanups.push(f.dispose);
  await f.host.call(f.actor, "installPlugin", {
    ...f.target,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
  });
  const input = { ...f.target, pluginId: f.bundled.id, enabled: false };
  await expect(
    f.host.call(f.reader, "setPluginEnabled", input),
  ).rejects.toMatchObject({
    code: "forbidden",
    statusCode: 403,
  });
  await expect(
    f.withoutAdmin.call(f.actor, "setPluginEnabled", input),
  ).rejects.toThrow("管理员服务");
  await expect(
    f.host.call(f.actor, "setPluginEnabled", { ...input, scope: "workspace" }),
  ).rejects.toThrow("项目层插件");
  const disabled = zcodePluginsSetEnabledResultSchema.parse(
    (await f.host.call(f.actor, "setPluginEnabled", input))?.result,
  );
  expect(disabled).toMatchObject({
    enabled: false,
    plugin: {
      id: f.bundled.id,
      enabled: false,
      marketplace: "kenfutwork-bundled",
    },
  });
  expect(f.tools.get("clock_now")).toBeUndefined();
  expect(
    zcodePluginsOverviewResultSchema.parse(
      (await f.host.call(f.reader, "getPluginsOverview", {}))?.result,
    ).installedPlugins,
  ).toMatchObject([{ id: f.bundled.id, enabled: false }]);
  const enabled = zcodePluginsSetEnabledResultSchema.parse(
    (
      await f.host.call(f.actor, "setPluginEnabled", {
        ...input,
        enabled: true,
      })
    )?.result,
  );
  expect(enabled).toMatchObject({
    enabled: true,
    plugin: { id: f.bundled.id, enabled: true },
  });
  const clock = f.tools.get("clock_now");
  if (!clock) throw new Error("恢复启用必须重新提供原clock_now工具");
  const result = await clock.execute({}, { workspaceId: f.workspaceId });
  expect(result).toMatchObject({
    iso: expect.any(String),
    epochMs: expect.any(Number),
  });
});
