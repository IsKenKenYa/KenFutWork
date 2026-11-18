import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

async function createLocalPluginFixture() {
  const dir = await mkdtemp(join(tmpdir(), "code-ui-package-"));
  const name = `ui-probe-${randomUUID()}`;
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.2.3",
      type: "module",
      main: "index.js",
      kenfutwork: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  await writeFile(
    join(dir, "cordis.patch.yml"),
    `- insert:\n    - id: probe\n      name: ${name}\n`,
  );
  await writeFile(
    join(dir, "index.js"),
    `export const name=${JSON.stringify(name)}; export function apply() {}`,
  );
  return { dir, name };
}

async function assertCorruptInventoryFails(
  read: (method: string) => ReturnType<typeof request>,
  statePath: string,
) {
  if (statePath !== join(isolatedHttp.pluginsDirectory(), "installed.json"))
    throw new Error("损坏库存测试仅允许本任务独占临时插件目录");
  const originalState = await readFile(statePath, "utf8");
  try {
    for (const damaged of [
      "{",
      '{"version":1,"installed":"broken"}',
      '{"version":1,"installed":[{"id":"probe"}]}',
    ]) {
      await writeFile(statePath, damaged);
      for (const method of ["listPlugins", "getPluginsOverview"]) {
        const failed = await read(method);
        expect(failed.status, JSON.stringify(failed.body)).toBe(500);
        expect(failed.body.error.message).toContain("插件库存损坏");
      }
      expect(await readFile(statePath, "utf8")).toBe(damaged);
    }
  } finally {
    await writeFile(statePath, originalState);
  }
}

const isolatedHttp = useCodeUiHttpFixture({ allowThirdPartyPlugins: true });
const { request } = isolatedHttp;

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原插件市场公开宿主接口 integration", () => {
  it("公开入口目录合并清单与运行时同键贡献，停用和卸载后不再提供入口", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ui-entries-"));
    try {
      const name = `entry-${randomUUID()}`;
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          type: "module",
          main: "index.js",
          kenfutwork: {
            bundle: { patch: "./cordis.patch.yml" },
            scope: "code",
            ui: [
              {
                id: "panel",
                title: "声明入口",
                slot: "sidebar",
                url: "declared.html",
              },
            ],
          },
        }),
      );
      await writeFile(
        join(root, "cordis.patch.yml"),
        `- insert:\n    - id: entry\n      name: ${name}\n`,
      );
      await writeFile(
        join(root, "index.js"),
        `export const name=${JSON.stringify(name)}; export function apply(ctx) { ctx.ui.register({ id: "panel", title: "运行入口", slot: "sidebar", url: "runtime.html" }); ctx.ui.register({ id: "extra", title: "动态入口", slot: "sidebar", url: "extra.html" }); }`,
      );
      const installed = await request("/api/plugins/install", {
        url: root,
        allowLifecycleScripts: false,
      });
      expect(installed.status, JSON.stringify(installed.body)).toBe(201);
      const id = installed.body.installed.id;
      const entry = (await request("/api/plugins")).body.plugins.find(
        (item: { id: string }) => item.id === id,
      );
      expect(entry.scope).toBe("code");
      expect(entry.ui).toEqual([
        {
          id: "panel",
          title: "运行入口",
          slot: "sidebar",
          url: "runtime.html",
          icon: null,
        },
        {
          id: "extra",
          title: "动态入口",
          slot: "sidebar",
          url: "extra.html",
          icon: null,
        },
      ]);
      await request(`/api/plugins/${id}/toggle`, { enabled: false });
      expect(
        (await request("/api/plugins")).body.plugins.find(
          (item: { id: string }) => item.id === id,
        ).ui,
      ).toEqual([]);
      await request(`/api/plugins/${id}/uninstall`, {});
      expect(
        (await request("/api/plugins")).body.plugins.some(
          (item: { id: string }) => item.id === id,
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("停用包的真实声明图标仍可读取，运行面板资源保持禁用", async () => {
    const installed = await request("/api/plugins/install", {
      builtin: "kenfutwork-mihome",
      allowLifecycleScripts: false,
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    const id = installed.body.installed.id;
    expect(
      (await request(`/api/plugins/${id}/toggle`, { enabled: false })).status,
    ).toBe(200);
    const icon = await isolatedHttp.readResource(
      `/api/plugins/${id}/assets/icon.svg`,
    );
    expect(icon.status).toBe(200);
    expect(Buffer.from(icon.bytes)).toEqual(
      await readFile(
        fileURLToPath(
          new URL("../../../../../plugins/mihome/icon.svg", import.meta.url),
        ),
      ),
    );
    expect(
      (await isolatedHttp.readResource(`/api/plugins/${id}/assets/panel.html`))
        .status,
    ).toBe(404);
  });

  it("实例插件的原安装、启停和卸载不需要创建Project或Task", async () => {
    const rpc = (method: string, input: unknown) =>
      request("/api/code-ui/rpc", {
        service: "plugin-management",
        method,
        args: [input],
      });
    const installed = await rpc("installPlugin", {
      pluginName: "kenfutwork-example-clock",
      marketplace: "kenfutwork-bundled",
      scope: "user",
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    const id = installed.body.result.installedPlugins[0].id;
    const disabled = await rpc("setPluginEnabled", {
      pluginId: id,
      enabled: false,
      scope: "user",
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.result.enabled).toBe(false);
    const removed = await rpc("uninstallPlugin", { pluginId: id });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const overview = await rpc("getPluginsOverview", { configScope: "user" });
    expect(overview.body.result.installedPlugins).toEqual([]);
    const late = await rpc("setPluginEnabled", { pluginId: id, enabled: true });
    expect(late.status).toBe(404);
  });

  it("同名本机包不能占用官方发行身份或被标为官方来源", async () => {
    const installed = await request("/api/plugins/install", {
      url: fileURLToPath(
        new URL("../../../../../plugins/example-clock", import.meta.url),
      ),
      allowLifecycleScripts: false,
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    const overview = await request("/api/code-ui/rpc", {
      service: "plugin-management",
      method: "getPluginsOverview",
      args: [{ configScope: "user" }],
    });
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    const view = zcodePluginsOverviewResultSchema.parse(overview.body.result);
    const official = view.availablePlugins.find(
      (entry) => entry.name === "kenfutwork-example-clock",
    );
    expect(official?.id).not.toBe(installed.body.installed.id);
    expect(
      view.installedPlugins.find(
        (entry) => entry.id === installed.body.installed.id,
      )?.marketplace,
    ).toBe("kenfutwork-local");
  });

  it("停用的包仍是已安装，公开REST分别返回安装与启用状态", async () => {
    const installed = await request("/api/plugins/install", {
      builtin: "kenfutwork-example-clock",
      allowLifecycleScripts: false,
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    const id = installed.body.installed.id;
    const disabled = await request(`/api/plugins/${id}/toggle`, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({ id, installed: true, enabled: false });
    const catalog = await request("/api/plugins");
    expect(
      catalog.body.plugins.find((entry: { id: string }) => entry.id === id),
    ).toMatchObject({ installed: true, enabled: false, ui: [] });
  });

  it("未选择项目时，官方目录投影米家的真实包图标，安装前资源可读取", async () => {
    const overview = await request("/api/code-ui/rpc", {
      service: "plugin-management",
      method: "getPluginsOverview",
      args: [{ configScope: "user" }],
    });
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    const view = zcodePluginsOverviewResultSchema.parse(overview.body.result);
    const mihome = view.availablePlugins.find(
      (entry) => entry.name === "kenfutwork-mihome",
    );
    expect(mihome?.marketplace).toBe("kenfutwork-bundled");
    expect(mihome?.listing).toMatchObject({
      displayName: "米家",
      icon: `/api/plugins/${mihome?.id}/assets/icon.svg`,
    });
    if (!mihome?.listing?.icon) throw new Error("真实目录没有返回图标引用");
    const asset = await isolatedHttp.readResource(mihome.listing.icon);
    expect(asset.status).toBe(200);
    expect(asset.contentType).toContain("image/svg+xml");
    expect(Buffer.from(asset.bytes)).toEqual(
      await readFile(
        fileURLToPath(
          new URL("../../../../../plugins/mihome/icon.svg", import.meta.url),
        ),
      ),
    );
  });

  it("原目录与运行列表读取真实机器插件库存，系统内核不伪装成可卸载插件包", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-ui-market-"));
    let projectId = "";
    try {
      const opened = await request("/api/code-ui/rpc", {
        service: "workspace",
        method: "open",
        args: [{ path: dir }],
      });
      expect(opened.status).toBe(200);
      projectId = opened.body.result.projectId;
      const read = (method: string) =>
        request("/api/code-ui/rpc", {
          service: "plugin-management",
          method,
          args: [
            { workspacePath: opened.body.result.path, configScope: "user" },
          ],
        });
      const overview = await read("getPluginsOverview");
      expect(overview.status, JSON.stringify(overview.body)).toBe(200);
      const view = zcodePluginsOverviewResultSchema.parse(overview.body.result);
      const raw = await request("/api/plugins");
      const bundled = raw.body.plugins.filter(
        (entry: { source: string; installability: string | null }) =>
          entry.source === "builtin" && entry.installability !== null,
      );
      expect(view.availablePlugins.map((entry) => entry.id).sort()).toEqual(
        bundled.map((entry: { id: string }) => entry.id).sort(),
      );
      expect(
        view.availablePlugins.some(
          (entry) =>
            entry.id === "agent-runs" || entry.id === "model-providers",
        ),
      ).toBe(false);
      const list = await read("listPlugins");
      expect(list.status).toBe(200);
      const plugins = zcodePluginsListResultSchema.parse(list.body.result);
      expect(
        plugins.plugins.some(
          (entry) =>
            entry.id === "agent-runs" || entry.id === "model-providers",
        ),
      ).toBe(false);
      expect(view.capability.supported).toBe(true);
    } finally {
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!enabled || process.env.CODE_UI_TEST_ISOLATED_PLUGINS !== "1")(
  "原插件真实安装态 integration",
  () => {
    it("停用仍是已安装包，版本/路径来自库存，源存在时不标为孤立", async () => {
      const { dir, name } = await createLocalPluginFixture();
      let projectId = "";
      let id = "";
      try {
        const installed = await request("/api/plugins/install", {
          url: dir,
          allowLifecycleScripts: false,
        });
        expect(installed.status, JSON.stringify(installed.body)).toBe(201);
        id = installed.body.installed.id;
        const opened = await request("/api/code-ui/rpc", {
          service: "workspace",
          method: "open",
          args: [{ path: dir }],
        });
        projectId = opened.body.result.projectId;
        const read = (method: string) =>
          request("/api/code-ui/rpc", {
            service: "plugin-management",
            method,
            args: [
              { workspacePath: opened.body.result.path, configScope: "user" },
            ],
          });
        expect(
          (await request(`/api/plugins/${id}/toggle`, { enabled: false }))
            .status,
        ).toBe(200);
        const listed = await read("listPlugins");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const plugins = zcodePluginsListResultSchema.parse(listed.body.result);
        expect(plugins.plugins.find((entry) => entry.id === id)).toMatchObject({
          id,
          name,
          version: "1.2.3",
          enabled: false,
          rootSource: "user",
          enabledSource: "user",
        });
        const overview = await read("getPluginsOverview");
        const view = zcodePluginsOverviewResultSchema.parse(
          overview.body.result,
        );
        const packageEntry = view.installedPlugins.find(
          (entry) => entry.id === id,
        );
        const listedPackage = plugins.plugins.find((entry) => entry.id === id);
        if (!packageEntry?.installPath || !listedPackage)
          throw new Error("原库存未返回真实安装包与安装路径");
        expect(packageEntry).toMatchObject({
          id,
          name,
          version: "1.2.3",
          enabled: false,
          scope: "user",
          installPath: listedPackage.rootPath,
        });
        expect(
          view.marketplaces.some(
            (entry) => entry.id === packageEntry.marketplace,
          ),
        ).toBe(true);
        const statePath = join(
          dirname(packageEntry.installPath),
          "installed.json",
        );
        await assertCorruptInventoryFails(read, statePath);
        expect((await read("listPlugins")).status).toBe(200);
        expect((await request(`/api/plugins/${id}/uninstall`, {})).status).toBe(
          200,
        );
        id = "";
        const after = zcodePluginsListResultSchema.parse(
          (await read("listPlugins")).body.result,
        );
        expect(after.plugins.some((entry) => entry.name === name)).toBe(false);
      } finally {
        if (id) await request(`/api/plugins/${id}/uninstall`, {});
        if (projectId)
          await request(`/api/projects/${projectId}`, undefined, "DELETE");
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
