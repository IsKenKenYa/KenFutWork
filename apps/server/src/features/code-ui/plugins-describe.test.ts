import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodePluginsListResultSchema } from "@kenfutwork/shared";
import { zcodePluginsDescribeResultSchema } from "@zcode/shared";
import { afterEach, expect, it } from "vitest";
import { createPluginManagementFixture } from "./plugins.test-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function addSkillFile(
  f: Awaited<ReturnType<typeof createPluginManagementFixture>>,
) {
  const skillDirectory = join(
    f.directory,
    "source",
    "skills",
    "inspect-project",
  );
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: inspect-project\ndescription: 检查真实项目文件\n---\n读取目录中的项目文件。\n",
  );
  const relative = "skills/inspect-project/SKILL.md";
  f.bundled.files[relative] = await readFile(skillPath, "utf8");
  return relative;
}

it("原describe候选从真实SKILL文件发现组件，读取不执行模块或生成安装状态", async () => {
  const f = await createPluginManagementFixture();
  cleanups.push(f.dispose);
  await addSkillFile(f);
  // 描述只读包数据；任何模块求值都会使该请求失败。
  f.bundled.files["index.js"] = 'throw new Error("describe不得执行插件模块");';
  const before = await readdir(f.directory, { recursive: true });
  const described = await f.host.call(f.actor, "describePlugin", {
    ...f.target,
    pluginName: f.bundled.name,
    marketplace: "kenfutwork-bundled",
  });
  expect(described?.result).toMatchObject({
    metadata: { version: "1.0.0" },
    components: [
      {
        kind: "skill",
        items: [{ name: "inspect-project", description: "检查真实项目文件" }],
      },
    ],
  });
  expect(await readdir(f.directory, { recursive: true })).toEqual(before);
  await expect(
    readFile(join(f.directory, "plugins", "installed.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("原list与describe共同读取已安装包真实skill，停用后组件仍可见且读取不执行模块", async () => {
  const f = await createPluginManagementFixture();
  cleanups.push(f.dispose);
  const relative = await addSkillFile(f);
  const { installed } = await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  await f.registry.setEnabled(installed.id, false);
  const root = join(f.directory, "plugins", installed.id);
  // 安装后读取实际包文件；不能重新拿未安装候选的缓存名称冒充已安装组件。
  await writeFile(
    join(root, relative),
    "---\nname: persisted-skill\ndescription: 来自已安装包的真实技能\n---\n已安装内容。\n",
  );
  await writeFile(
    join(root, "index.js"),
    'throw new Error("组件读取不得重新装载已停用模块");',
  );
  const statePath = join(f.directory, "plugins", "installed.json");
  const stateBefore = await readFile(statePath, "utf8");
  const filesBefore = await readdir(f.directory, { recursive: true });
  const described = zcodePluginsDescribeResultSchema.parse(
    (
      await f.host.call(f.actor, "describePlugin", {
        ...f.target,
        pluginName: f.bundled.name,
        marketplace: "kenfutwork-bundled",
      })
    )?.result,
  );
  expect(described.components).toEqual([
    {
      kind: "skill",
      items: [
        { name: "persisted-skill", description: "来自已安装包的真实技能" },
      ],
    },
  ]);
  const listed = zcodePluginsListResultSchema.parse(
    (
      await f.host.call(f.actor, "listPlugins", {
        ...f.target,
        configScope: "user",
      })
    )?.result,
  );
  expect(listed.plugins).toMatchObject([
    {
      id: installed.id,
      enabled: false,
      skillRootCount: 1,
      skillCount: 1,
      commandRootCount: 0,
      mcpServerNames: [],
    },
  ]);
  expect(listed.plugins[0]?.components).toEqual(described.components);
  expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  expect(await readdir(f.directory, { recursive: true })).toEqual(filesBefore);
});

it("原describe拒绝未知marketplace、未知包与remote目标，不改写本机安装状态", async () => {
  const f = await createPluginManagementFixture();
  cleanups.push(f.dispose);
  const before = await readdir(f.directory, { recursive: true });
  await expect(
    f.host.call(f.actor, "describePlugin", {
      ...f.target,
      pluginName: f.bundled.name,
      marketplace: "unknown",
    }),
  ).rejects.toMatchObject({ code: "plugin_not_found" });
  await expect(
    f.host.call(f.actor, "describePlugin", {
      ...f.target,
      pluginName: "unknown",
      marketplace: "kenfutwork-bundled",
    }),
  ).rejects.toMatchObject({ code: "plugin_not_found" });
  await expect(
    f.host.call(f.actor, "describePlugin", {
      ...f.target,
      pluginName: f.bundled.name,
      marketplace: "kenfutwork-bundled",
      remoteSessionId: "remote-unknown",
    }),
  ).rejects.toThrow("未装配远程");
  expect(await readdir(f.directory, { recursive: true })).toEqual(before);
  await expect(
    readFile(join(f.directory, "plugins", "installed.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("原list与describe不跟随已安装包skill目录符号链接，不能读取包根外技能", async () => {
  const f = await createPluginManagementFixture();
  cleanups.push(f.dispose);
  await addSkillFile(f);
  const { installed } = await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  await f.registry.setEnabled(installed.id, false);
  const outside = join(f.directory, "outside-package");
  await mkdir(outside);
  await writeFile(
    join(outside, "SKILL.md"),
    "---\nname: outside-skill\ndescription: 不能越包根读取\n---\n外部内容。\n",
  );
  await symlink(
    outside,
    join(f.directory, "plugins", installed.id, "skills", "outside"),
  );
  const described = zcodePluginsDescribeResultSchema.parse(
    (
      await f.host.call(f.actor, "describePlugin", {
        ...f.target,
        pluginName: f.bundled.name,
        marketplace: "kenfutwork-bundled",
      })
    )?.result,
  );
  const listed = zcodePluginsListResultSchema.parse(
    (
      await f.host.call(f.actor, "listPlugins", {
        ...f.target,
        configScope: "user",
      })
    )?.result,
  );
  expect(described.components).toEqual([
    {
      kind: "skill",
      items: [{ name: "inspect-project", description: "检查真实项目文件" }],
    },
  ]);
  expect(listed.plugins[0]?.components).toEqual(described.components);
  expect(listed.plugins[0]?.skillCount).toBe(1);
});
