import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

async function createPluginProject(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const opened = await request("/api/code-ui/rpc", {
    service: "workspace",
    method: "open",
    args: [{ path: dir }],
  });
  expect(opened.status).toBe(200);
  return {
    call: (method: string, fields = {}) =>
      request("/api/code-ui/rpc", {
        service: "plugin-management",
        method,
        args: [{ workspacePath: opened.body.result.path, ...fields }],
      }),
    async dispose() {
      await request(
        `/api/projects/${opened.body.result.projectId}`,
        undefined,
        "DELETE",
      );
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const isolatedHttp = useCodeUiHttpFixture();
const { request } = isolatedHttp;

const enabled =
  process.env.RUN_CODE_UI_INTEGRATION === "1" &&
  process.env.CODE_UI_TEST_ISOLATED_PLUGINS === "1";

describe.skipIf(!enabled)("原插件包操作公开宿主 integration", () => {
  it("自带包经原安装、停用与卸载命令改变真实库存，停用保留安装且卸载后迟到启用不复活", async () => {
    const host = await createPluginProject("code-ui-package-actions-");
    const { call } = host;
    let pluginId = "";
    try {
      const installed = await call("installPlugin", {
        pluginName: "kenfutwork-example-clock",
        marketplace: "kenfutwork-bundled",
        scope: "user",
      });
      expect(installed.status, JSON.stringify(installed.body)).toBe(200);
      expect(installed.body.result.installedPlugins).toHaveLength(1);
      const record = installed.body.result.installedPlugins[0];
      pluginId = record.id;
      expect(record).toMatchObject({
        name: "kenfutwork-example-clock",
        version: "1.0.0",
        enabled: true,
        scope: "user",
      });
      const disabled = await call("setPluginEnabled", {
        pluginId,
        enabled: false,
        scope: "user",
      });
      expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
      expect(disabled.body.result.plugin).toMatchObject({
        id: pluginId,
        enabled: false,
      });
      const repeated = await call("installPlugin", {
        pluginName: "kenfutwork-example-clock",
        marketplace: "kenfutwork-bundled",
        scope: "user",
      });
      expect(repeated.status).toBe(200);
      expect(repeated.body.result.installedPlugins[0]).toMatchObject({
        id: pluginId,
        enabled: false,
      });
      const overview = await call("getPluginsOverview", {
        configScope: "user",
      });
      expect(
        overview.body.result.availablePlugins.find(
          (item: { id: string }) => item.id === pluginId,
        ),
      ).toMatchObject({ installed: true });
      expect(
        overview.body.result.installedPlugins.find(
          (item: { id: string }) => item.id === pluginId,
        ),
      ).toMatchObject({ enabled: false });
      const removed = await call("uninstallPlugin", {
        pluginId,
        removeCache: true,
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.result.removedPlugin).toMatchObject({
        id: pluginId,
        enabled: false,
      });
      const late = await call("setPluginEnabled", {
        pluginId,
        enabled: true,
        scope: "user",
      });
      expect(late.status).toBe(404);
      const after = await call("getPluginsOverview", { configScope: "user" });
      expect(
        after.body.result.availablePlugins.find(
          (item: { id: string }) => item.id === pluginId,
        ),
      ).toMatchObject({ installed: false });
      expect(
        after.body.result.installedPlugins.some(
          (item: { id: string }) => item.id === pluginId,
        ),
      ).toBe(false);
      pluginId = "";
    } finally {
      if (pluginId) await request(`/api/plugins/${pluginId}/uninstall`, {});
      await host.dispose();
    }
  });
  it("同一宿主并发安装两包后都能从原库存读回，不丢失另一操作记录", async () => {
    const host = await createPluginProject("code-ui-parallel-packages-");
    const { call } = host;
    try {
      const names = ["kenfutwork-example-clock", "kenfutwork-demo-panel"];
      const results = await Promise.all(
        names.map((pluginName) =>
          call("installPlugin", {
            pluginName,
            marketplace: "kenfutwork-bundled",
            scope: "user",
          }),
        ),
      );
      for (const result of results) {
        expect(result.status, JSON.stringify(result.body)).toBe(200);
      }
      const overview = await call("getPluginsOverview", {
        configScope: "user",
      });
      expect(overview.status, JSON.stringify(overview.body)).toBe(200);
      expect(
        overview.body.result.installedPlugins
          .map((item: { name: string }) => item.name)
          .filter((name: string) => names.includes(name))
          .sort(),
      ).toEqual(["kenfutwork-demo-panel", "kenfutwork-example-clock"]);
    } finally {
      // 即使错误记录被覆盖，按稳定自带包ID清理；不触碰其它机器插件。
      for (const id of [
        "local__kenfutwork-example-clock",
        "local__kenfutwork-demo-panel",
      ])
        await request(`/api/plugins/${id}/uninstall`, {});
      await host.dispose();
    }
  });
  it("原显式保留缓存卸载移除安装但保留包文件，结果报告已移除的启用态false", async () => {
    const host = await createPluginProject("code-ui-keep-package-cache-");
    const { call } = host;
    let pluginId = "";
    try {
      const installed = await call("installPlugin", {
        pluginName: "kenfutwork-example-clock",
        marketplace: "kenfutwork-bundled",
        scope: "user",
      });
      expect(installed.status).toBe(200);
      const record = installed.body.result.installedPlugins[0];
      pluginId = record.id;
      const removed = await call("uninstallPlugin", {
        pluginId,
        removeCache: false,
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.result.removedPlugin).toMatchObject({
        id: pluginId,
        enabled: false,
      });
      expect(
        (await stat(join(record.installPath, "package.json"))).isFile(),
      ).toBe(true);
      const after = await call("getPluginsOverview", { configScope: "user" });
      expect(
        after.body.result.installedPlugins.some(
          (item: { id: string }) => item.id === pluginId,
        ),
      ).toBe(false);
    } finally {
      // 用真实公开安装/彻底卸载回收本用例保留的缓存；不操作其它安装目录。
      if (pluginId) {
        await call("installPlugin", {
          pluginName: "kenfutwork-example-clock",
          marketplace: "kenfutwork-bundled",
          scope: "user",
        });
        await call("uninstallPlugin", { pluginId, removeCache: true });
      }
      await host.dispose();
    }
  });
});
