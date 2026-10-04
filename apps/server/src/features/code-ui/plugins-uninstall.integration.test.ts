import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  zcodePluginsInstallResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsUninstallResultSchema,
} from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
} from "../model-providers/secret-store.js";
import { createPluginStorage } from "../plugins/plugin-storage.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createPluginManagementFixture } from "./plugins.test-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.env.KENFUTWORK_CODE_PLUGINS_TEST_PG !== "1")(
  "原插件卸载公共契约与真实插件数据",
  () => {
    it("removeCache=false收回实例并保留缓存与加密数据，复装可用后默认卸载删除两者", async () => {
      const database = await createTaskWorkDatabase();
      cleanups.push(database.close);
      const credentialEnv = {
        credentialSecret: "plugin-uninstall-integration",
      };
      const storage = createPluginStorage({
        persistence: database.persistence,
        cipher: {
          encrypt: (value) => encryptSecret(credentialEnv, value),
          decrypt: (value) => decryptSecret(credentialEnv, value),
        },
      });
      const f = await createPluginManagementFixture({ storage });
      cleanups.push(f.dispose);
      const install = {
        ...f.target,
        pluginName: f.bundled.name,
        marketplace: "kenfutwork-bundled",
      };
      await f.host.call(f.actor, "installPlugin", install);
      const workspaceId = database.context.scope.workspaceId;
      await storage.set(workspaceId, f.bundled.id, "session", "保留的会话值");
      const input = { ...f.target, pluginId: f.bundled.id, removeCache: false };
      await expect(
        f.host.call(f.reader, "uninstallPlugin", input),
      ).rejects.toMatchObject({
        code: "forbidden",
        statusCode: 403,
      });
      await expect(
        f.withoutAdmin.call(f.actor, "uninstallPlugin", input),
      ).rejects.toThrow("管理员服务");
      await expect(
        f.host.call(f.actor, "uninstallPlugin", {
          ...input,
          projectId: randomUUID(),
        }),
      ).rejects.toThrow("项目插件目标无效");
      await expect(
        f.host.call(f.actor, "uninstallPlugin", {
          ...input,
          pluginId: "agent-runs",
        }),
      ).rejects.toMatchObject({ code: "system_plugin" });
      await expect(
        f.host.call(f.actor, "uninstallPlugin", {
          ...input,
          pluginId: "absent-package",
        }),
      ).rejects.toMatchObject({ code: "not_installed" });
      const removed = zcodePluginsUninstallResultSchema.parse(
        (await f.host.call(f.actor, "uninstallPlugin", input))?.result,
      );
      expect(removed.removedPlugin).toMatchObject({
        id: f.bundled.id,
        enabled: false,
      });
      expect(f.tools.get("clock_now")).toBeUndefined();
      const overview = zcodePluginsOverviewResultSchema.parse(
        (await f.host.call(f.reader, "getPluginsOverview", {}))?.result,
      );
      expect(overview.installedPlugins).toEqual([]);
      expect(overview.availablePlugins).toMatchObject([
        { id: f.bundled.id, installed: false },
      ]);
      const cacheEntry = join(f.directory, "plugins", f.bundled.id, "index.js");
      expect(await readFile(cacheEntry, "utf8")).toBe(
        f.bundled.files["index.js"],
      );
      await expect(
        storage.get(workspaceId, f.bundled.id, "session"),
      ).resolves.toBe("保留的会话值");
      const reinstalled = zcodePluginsInstallResultSchema.parse(
        (await f.host.call(f.actor, "installPlugin", install))?.result,
      );
      expect(reinstalled.installedPlugins).toMatchObject([
        { id: f.bundled.id, enabled: true },
      ]);
      const clock = f.tools.get("clock_now");
      if (!clock) throw new Error("复装必须恢复真实工具");
      expect(await clock.execute({}, { workspaceId })).toMatchObject({
        iso: expect.any(String),
      });
      await expect(
        storage.get(workspaceId, f.bundled.id, "session"),
      ).resolves.toBe("保留的会话值");
      zcodePluginsUninstallResultSchema.parse(
        (
          await f.host.call(f.actor, "uninstallPlugin", {
            ...f.target,
            pluginId: f.bundled.id,
          })
        )?.result,
      );
      await expect(readFile(cacheEntry)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        storage.get(workspaceId, f.bundled.id, "session"),
      ).resolves.toBeNull();
      expect(f.tools.get("clock_now")).toBeUndefined();
    }, 60_000);
  },
);
