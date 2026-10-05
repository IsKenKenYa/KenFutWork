import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadServerEnv } from "../../config/env.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { codeUiAuthorizedInject } from "./code-ui-http.fixture.js";

function pluginHostEnv(databaseUrl: string, dir: string) {
  return loadServerEnv(
    {
      databaseUrl,
      desktopDataDir: dir,
      queueDriver: "in-process",
      blobDir: join(dir, "blobs"),
      sandboxRoot: join(dir, "sandbox"),
      webOrigin: "http://localhost:3300",
    },
    {},
  );
}

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原Code自带包宿主重启 integration", () => {
  it("禁止第三方部署重启后仍恢复真实自带包路由与工具，原目录enabled不伪装成运行可用", async () => {
    const database = await createTaskWorkDatabase();
    const databaseUrl = database.connectionString;
    const dir = await mkdtemp(join(tmpdir(), "code-ui-builtin-restore-"));
    vi.stubEnv("KENFUTWORK_PLUGINS_DIR", join(dir, "plugins"));
    vi.stubEnv("KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS", "false");
    const env = pluginHostEnv(databaseUrl, dir);
    let app = buildApp({ env });
    let closed = false;
    try {
      const opened = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "workspace",
          method: "open",
          args: [{ path: dir }],
        },
      });
      expect(opened.statusCode).toBe(200);
      const workspacePath = opened.json().result.path;
      const denied = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/plugins/install",
        payload: { url: dir, allowLifecycleScripts: false },
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.message).toContain("不允许安装第三方插件");
      const installed = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "plugin-management",
          method: "installPlugin",
          args: [
            {
              workspacePath,
              marketplace: "kenfutwork-bundled",
              pluginName: "kenfutwork-demo-panel",
              scope: "user",
            },
          ],
        },
      });
      expect(installed.statusCode).toBe(200);
      const id = installed.json().result.installedPlugins[0].id;
      expect(
        (
          await codeUiAuthorizedInject(app, {
            url: `/api/plugins/${id}/data?probe=before`,
          })
        ).json(),
      ).toEqual({ ok: true, query: { probe: "before" } });
      await app.close();
      closed = true;
      app = buildApp({ env });
      closed = false;
      await app.ready();
      const after = await codeUiAuthorizedInject(app, {
        url: `/api/plugins/${id}/data?probe=after`,
      });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ ok: true, query: { probe: "after" } });
      const exported = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/plugins/export",
        payload: { name: id, format: "kenfutwork" },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().files["index.js"]).toContain(
        '"name": "demo_ping"',
      );
      const overview = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "plugin-management",
          method: "getPluginsOverview",
          args: [{ workspacePath, configScope: "user" }],
        },
      });
      expect(overview.statusCode).toBe(200);
      expect(
        overview
          .json()
          .result.installedPlugins.find(
            (record: { id: string }) => record.id === id,
          ),
      ).toMatchObject({ enabled: true });
    } finally {
      if (!closed) await app.close();
      vi.unstubAllEnvs();
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("同名第三方包不因id碰到自带目录而绕过重启策略", async () => {
    const database = await createTaskWorkDatabase();
    const databaseUrl = database.connectionString;
    const dir = await mkdtemp(join(tmpdir(), "code-ui-local-restore-denied-"));
    vi.stubEnv("KENFUTWORK_PLUGINS_DIR", join(dir, "plugins"));
    vi.stubEnv("KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS", "true");
    const env = pluginHostEnv(databaseUrl, dir);
    let app = buildApp({ env });
    let closed = false;
    try {
      const installed = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/plugins/install",
        payload: {
          url: fileURLToPath(
            new URL("../../../../../plugins/demo-panel", import.meta.url),
          ),
          allowLifecycleScripts: false,
        },
      });
      expect(installed.statusCode).toBe(201);
      const id = installed.json().installed.id;
      expect(installed.json().installed.source).toBe("url");
      expect(
        (await codeUiAuthorizedInject(app, { url: `/api/plugins/${id}/data` }))
          .statusCode,
      ).toBe(200);
      await app.close();
      closed = true;
      vi.stubEnv("KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS", "false");
      app = buildApp({ env });
      closed = false;
      await app.ready();
      expect(
        (await codeUiAuthorizedInject(app, { url: `/api/plugins/${id}/data` }))
          .statusCode,
      ).toBe(404);
      const exported = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/plugins/export",
        payload: { name: id, format: "kenfutwork" },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().files["index.js"]).not.toContain(
        '"name": "demo_ping"',
      );
      const opened = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "workspace",
          method: "open",
          args: [{ path: dir }],
        },
      });
      expect(opened.statusCode).toBe(200);
      const collision = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "plugin-management",
          method: "getPluginsOverview",
          args: [
            { workspacePath: opened.json().result.path, configScope: "user" },
          ],
        },
      });
      expect(collision.statusCode).toBe(200);
      expect(
        collision
          .json()
          .result.availablePlugins.find(
            (item: { name: string }) => item.name === "kenfutwork-demo-panel",
          ).id,
      ).toBe(id);
      const activation = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "plugin-management",
          method: "setPluginEnabled",
          args: [
            {
              workspacePath: opened.json().result.path,
              pluginId: id,
              enabled: true,
              scope: "user",
            },
          ],
        },
      });
      expect(activation.statusCode).toBe(400);
      expect(activation.json().error.message).toContain("不允许启用第三方插件");
      expect(
        (await codeUiAuthorizedInject(app, { url: `/api/plugins/${id}/data` }))
          .statusCode,
      ).toBe(404);
    } finally {
      if (!closed) await app.close();
      vi.unstubAllEnvs();
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("scoped npm 名称的自带包目录与安装id一致，禁止第三方重启后仍可启用和运行", async () => {
    const database = await createTaskWorkDatabase();
    const databaseUrl = database.connectionString;
    const dir = await mkdtemp(join(tmpdir(), "code-ui-scoped-builtin-"));
    const bundle = join(dir, "bundles", "probe");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, "package.json"),
      JSON.stringify({
        name: "@code-ui/probe",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        kenfutwork: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    await writeFile(
      join(bundle, "cordis.patch.yml"),
      `- insert:
    - id: probe
      name: "@code-ui/probe"
`,
    );
    await writeFile(
      join(bundle, "index.js"),
      'export const name="@code-ui/probe"; export const inject=["routes"]; export function apply(ctx){ctx.routes.register({path:"probe", handler:async()=>({scoped:true})});}',
    );
    vi.stubEnv("KENFUTWORK_PLUGINS_DIR", join(dir, "plugins"));
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", join(dir, "bundles"));
    vi.stubEnv("KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS", "false");
    const env = pluginHostEnv(databaseUrl, dir);
    let app = buildApp({ env });
    let closed = false;
    try {
      const opened = await codeUiAuthorizedInject(app, {
        method: "POST",
        url: "/api/code-ui/rpc",
        payload: {
          service: "workspace",
          method: "open",
          args: [{ path: dir }],
        },
      });
      expect(opened.statusCode).toBe(200);
      const workspacePath = opened.json().result.path;
      const rpc = (method: string, fields = {}) =>
        app.inject({
          method: "POST",
          url: "/api/code-ui/rpc",
          payload: {
            service: "plugin-management",
            method,
            args: [{ workspacePath, ...fields }],
          },
        });
      const installed = await rpc("installPlugin", {
        pluginName: "@code-ui/probe",
        marketplace: "kenfutwork-bundled",
        scope: "user",
      });
      expect(installed.statusCode).toBe(200);
      const id = installed.json().result.installedPlugins[0].id;
      const overview = await rpc("getPluginsOverview", { configScope: "user" });
      expect(overview.statusCode).toBe(200);
      expect(
        overview
          .json()
          .result.availablePlugins.find(
            (item: { name: string }) => item.name === "@code-ui/probe",
          ),
      ).toMatchObject({ id, installed: true });
      await app.close();
      closed = true;
      app = buildApp({ env });
      closed = false;
      await app.ready();
      expect(
        (
          await codeUiAuthorizedInject(app, { url: `/api/plugins/${id}/probe` })
        ).json(),
      ).toEqual({ scoped: true });
      const activation = await rpc("setPluginEnabled", {
        pluginId: id,
        enabled: true,
        scope: "user",
      });
      expect(activation.statusCode).toBe(200);
    } finally {
      if (!closed) await app.close();
      vi.unstubAllEnvs();
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
