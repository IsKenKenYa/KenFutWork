import { zcodePluginsReferenceCatalogResultSchema } from "@zcode/shared";
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

/**
 * 红条回归：Composer 的「+ → 插件」读这个 catalog。`call()` 曾对它 return null，
 * RPC 层于是 501，界面上就是「Code 宿主接口 plugin-management.
 * getPluginReferenceCatalog 尚未接通」。
 */
it("getPluginReferenceCatalog 有返回且形状合契约（无 sessionId = workspace 权威）", async () => {
  const f = await fixture();
  const response = await f.host.call(f.actor, "getPluginReferenceCatalog", {
    ...f.target,
  });
  expect(response).not.toBeNull();
  const result = zcodePluginsReferenceCatalogResultSchema.parse(
    response?.result,
  );
  expect(result.authority).toBe("workspace");
  expect(Array.isArray(result.plugins)).toBe(true);
  for (const plugin of result.plugins) {
    expect(plugin.pluginId.length).toBeGreaterThan(0);
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(Array.isArray(plugin.conflictingPluginIds)).toBe(true);
    expect(Array.isArray(plugin.skillQualifiedNames)).toBe(true);
    expect(Array.isArray(plugin.mcpServerNames)).toBe(true);
    expect(Array.isArray(plugin.subagentNames)).toBe(true);
  }
});

it("带 sessionId 的目录按会话冻结，后续调用拿到同一份", async () => {
  const f = await fixture();
  const params = { ...f.target, sessionId: "session-freeze" };
  const first = (await f.host.call(f.actor, "getPluginReferenceCatalog", params))
    ?.result;
  expect(
    zcodePluginsReferenceCatalogResultSchema.parse(first).authority,
  ).toBe("session");
  const second = (await f.host.call(f.actor, "getPluginReferenceCatalog", params))
    ?.result;
  // 冻结的意义是「同一份对象」：不是重新算一遍再碰巧相等
  expect(second).toBe(first);
});

it("装好的插件会作为条目出现在目录里（picker 才有东西可选）", async () => {
  const f = await fixture();
  await f.host.call(f.actor, "installPlugin", {
    ...f.target,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
    scope: "user",
  });
  const result = zcodePluginsReferenceCatalogResultSchema.parse(
    (await f.host.call(f.actor, "getPluginReferenceCatalog", { ...f.target }))
      ?.result,
  );
  const entry = result.plugins.find((plugin) => plugin.name === f.bundled.name);
  expect(entry).toBeDefined();
  expect(entry?.pluginId.length).toBeGreaterThan(0);
  expect(entry?.enabled).toBe(true);
  expect(entry?.conflictingPluginIds).toEqual([]);
});

it("未知方法仍然返回 null，不把未接线的方法伪装成成功", async () => {
  const f = await fixture();
  await expect(
    f.host.call(f.actor, "definitelyNotImplemented", {}),
  ).resolves.toBeNull();
});
