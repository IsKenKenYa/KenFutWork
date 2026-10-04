import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { request } from "./host-client.fixture.js";

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
  if (
    !/[/]ken-code-owned-db-[^/]+[/]plugins[/]installed\.json$/u.test(statePath)
  )
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

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原插件市场公开宿主接口 integration", () => {
  it("原目录与运行列表读取真实机器插件库存，系统内核不伪装成可卸载插件包", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
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
      expect((await request("/api/viewer")).status).toBe(200);
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
