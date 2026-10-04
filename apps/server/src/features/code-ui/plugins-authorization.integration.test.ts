import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadServerEnv } from "../../config/env.js";

const enabled =
  process.env.RUN_CODE_UI_INTEGRATION === "1" &&
  Boolean(process.env.CODE_UI_TEST_DATABASE_URL);

describe.skipIf(!enabled)("原插件命令真实权限 integration", () => {
  it("managed 普通用户可读取真实目录，但安装/启停/卸载全部由既有管理员门返回403", async () => {
    const databaseUrl = process.env.CODE_UI_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("权限用例需要独占测试数据库");
    const dir = await mkdtemp(join(tmpdir(), "code-ui-managed-packages-"));
    vi.stubEnv("KENFUTWORK_PLUGINS_DIR", join(dir, "plugins"));
    const app = buildApp({
      env: loadServerEnv(
        {
          databaseUrl,
          authDriver: "managed",
          queueDriver: "in-process",
          credentialSecret: randomBytes(32).toString("hex"),
          blobDir: join(dir, "blobs"),
          sandboxRoot: join(dir, "sandbox"),
          webOrigin: "http://localhost:3300",
        },
        {},
      ),
    });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: `code-package-${randomUUID()}@example.invalid`,
          password: randomBytes(24).toString("hex"),
        },
      });
      expect(signup.statusCode).toBe(201);
      const headers = {
        authorization: `Bearer ${signup.json().session.token}`,
      };
      const call = (service: string, method: string, fields = {}) =>
        app.inject({
          method: "POST",
          url: "/api/code-ui/rpc",
          headers,
          payload: { service, method, args: [fields] },
        });
      const opened = await call("workspace", "open", { path: dir });
      expect(opened.statusCode).toBe(200);
      const target = { workspacePath: opened.json().result.path };
      const read = await call("plugin-management", "getPluginsOverview", {
        ...target,
        configScope: "user",
      });
      expect(read.statusCode).toBe(200);
      for (const [method, fields] of [
        [
          "installPlugin",
          {
            pluginName: "kenfutwork-example-clock",
            marketplace: "kenfutwork-bundled",
            scope: "user",
          },
        ],
        [
          "setPluginEnabled",
          {
            pluginId: "local__kenfutwork-example-clock",
            enabled: true,
            scope: "user",
          },
        ],
        [
          "uninstallPlugin",
          { pluginId: "local__kenfutwork-example-clock", removeCache: true },
        ],
      ] as const) {
        const denied = await call("plugin-management", method, {
          ...target,
          ...fields,
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe("forbidden");
      }
      const after = await call("plugin-management", "getPluginsOverview", {
        ...target,
        configScope: "user",
      });
      expect(after.json().result.installedPlugins).toEqual([]);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
