import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const { request, pluginsDirectory } = useCodeUiHttpFixture({
  allowThirdPartyPlugins: true,
});

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "无Project原市场来源检查与安装使用现有注册表，本机源安装停用后重装保持停用 integration",
  async () => {
    for (const project of (await request("/api/projects?kind=code")).body
      .projects)
      expect(
        (await request(`/api/projects/${project.id}`, undefined, "DELETE"))
          .status,
      ).toBe(204);
    const source = join(pluginsDirectory(), "source-probe");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "source-probe",
        version: "1.0.0",
        type: "module",
        main: "index.mjs",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    await writeFile(
      join(source, "cordis.patch.yml"),
      "- insert:\n    - id: source-probe\n      name: source-probe\n      inject: [tools]\n",
    );
    await writeFile(
      join(source, "index.mjs"),
      'export const name = "source-probe"; export const inject = ["tools"]; export function apply(ctx) { ctx.effect(() => ctx.tools.register({ name: "source_probe", description: "源码入口探针", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "源码入口" }] }) })); }',
    );
    const rpc = (method: string) =>
      request("/api/code-ui/rpc", {
        service: "plugin-management",
        method,
        args: [{ url: source }],
      });
    const inspected = await rpc("inspectPluginSource");
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body.result).toMatchObject({
      manifest: { name: "source-probe" },
      report: { compatible: true },
    });
    expect(
      (await request("/api/plugins")).body.plugins.some(
        (p: { name: string }) => p.name === "source-probe",
      ),
    ).toBe(false);
    const installed = await rpc("installPluginFromSource");
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    expect(installed.body.result.installed).toMatchObject({
      name: "source-probe",
      enabled: true,
    });
    const id = installed.body.result.installed.id;
    expect(
      (await request(`/api/plugins/${id}/toggle`, { enabled: false })).status,
    ).toBe(200);
    expect(
      (await rpc("installPluginFromSource")).body.result.installed,
    ).toMatchObject({ id, enabled: false });
    expect((await request("/api/projects?kind=code")).body.projects).toEqual(
      [],
    );
  },
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原来源检查回传真实生命周期阻断，宿主不得绕过门禁或产生安装记录 integration",
  async () => {
    const source = join(pluginsDirectory(), "blocked-source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "blocked-source",
        version: "1.0.0",
        type: "module",
        main: "index.mjs",
        scripts: { postinstall: "node index.mjs" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    await writeFile(
      join(source, "cordis.patch.yml"),
      "- insert:\n    - id: blocked-source\n      name: blocked-source\n      inject: [tools]\n",
    );
    await writeFile(
      join(source, "index.mjs"),
      'export const name = "blocked-source"; export const inject = ["tools"]; export function apply(ctx) {}',
    );
    const inspected = await request("/api/code-ui/rpc", {
      service: "plugin-management",
      method: "inspectPluginSource",
      args: [{ url: source }],
    });
    expect(inspected.status).toBe(200);
    expect(inspected.body.result.report).toMatchObject({
      compatible: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "lifecycle_script_present",
          severity: "blocker",
        }),
      ]),
    });
    const forbidden = await request("/api/code-ui/rpc", {
      service: "plugin-management",
      method: "installPluginFromSource",
      args: [{ url: source, allowLifecycleScripts: true }],
    });
    expect(forbidden.status).toBe(400);
    const rejected = await request("/api/code-ui/rpc", {
      service: "plugin-management",
      method: "installPluginFromSource",
      args: [{ url: source }],
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe("plugin_incompatible");
    expect(
      (await request("/api/plugins")).body.plugins.some(
        (item: { name: string }) => item.name === "blocked-source",
      ),
    ).toBe(false);
  },
);
