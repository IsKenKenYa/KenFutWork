import { afterEach, expect, it } from "vitest";
import { createInstanceSkillsByInstanceLoader } from "../../agent/workspace-skills.js";
import { renderSkillsSection } from "../agent-runs/prompt-sections.js";
import { createCodeUiSkillsHost } from "../skills/code-ui-host.js";
import { createSkillCatalogService } from "../skills/skill-catalog-service.js";
import { createInstanceSkillResourceReader } from "../skills/skill-resource-service.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { createPluginManagementFixture } from "./plugins.test-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0)) await release();
});

it("同名技能用包内资源身份精确读取，Code限定包不进入Design且跨实例不可读", async () => {
  const f = await createPluginManagementFixture();
  cleanup.push(f.dispose);
  const { localInstance } = createCodeUiTestInstance(
    f.instanceId,
    null,
    f.directory,
  );
  const packageJson = JSON.parse(f.bundled.files["package.json"] ?? "{}");
  packageJson.kenfutwork.scope = "code";
  f.bundled.files["package.json"] = JSON.stringify(packageJson);
  for (const [directory, suffix] of [
    ["a", "A😀"],
    ["b", "B😀"],
  ])
    f.bundled.files[`skills/${directory}/SKILL.md`] =
      `---\nname: same-name\ndescription: 同名\n---\n${suffix}`;
  const installed = await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  expect(
    (await f.registry.readPackageDescription(installed.installed.id)).skills,
  ).toHaveLength(2);
  const repository = {
    listInstanceSkills: async () => [],
    listSkillFiles: async () => [],
  };
  const catalog = createSkillCatalogService({
    localInstance,
    repository,
    plugins: f.registry,
  });
  const code = await catalog.listSkills(f.instanceId, "code");
  expect(code).toHaveLength(2);
  expect(new Set(code.map((entry) => entry.name)).size).toBe(2);
  expect(await catalog.listSkills(f.instanceId, "design")).toEqual([]);
  expect(
    await catalog.getSkill(f.instanceId, "same-name", "code"),
  ).toBeUndefined();
  for (const [index, suffix] of ["A😀", "B😀"].entries()) {
    const reference = code[index]?.name;
    if (!reference) throw new Error("缺少技能身份");
    expect(
      (await catalog.getSkill(f.instanceId, reference, "code"))?.content,
    ).toContain(suffix);
    expect(
      await catalog.getSkill(f.instanceId, reference, "design"),
    ).toBeUndefined();
    await expect(
      catalog.getSkill(
        "00000000-0000-4000-8000-000000000099",
        reference,
        "code",
      ),
    ).rejects.toThrow();
  }
});

it("原技能RPC显示安装包中的只读定义，运行目录按真实模式读取正文与附属资源，停用不卸载", async () => {
  const f = await createPluginManagementFixture();
  cleanup.push(f.dispose);
  const { localInstance } = createCodeUiTestInstance(
    f.instanceId,
    null,
    f.directory,
  );
  const body =
    "---\nname: inspect-project\ndescription: 插件技能😀\n---\n# 检查\n";
  f.bundled.files["skills/inspect-project/SKILL.md"] = body;
  f.bundled.files["skills/inspect-project/references/说明.md"] = "原资源😀";
  const installed = await f.registry.install({
    builtin: f.bundled.name,
    allowLifecycleScripts: false,
  });
  const repository = {
    listInstanceSkills: async () => [],
    listSkillFiles: async () => [],
    setEnabled: async () => {
      throw new Error("不能修改DB安装态");
    },
    uninstall: async () => {
      throw new Error("不能卸载DB安装态");
    },
  };
  const host = createCodeUiSkillsHost({
    localInstance,
    repository,
    plugins: f.registry,
  });
  const listing = host["skills.list"];
  if (!listing) throw new Error("技能RPC未注册");
  const result = await listing.call(f.actor, [{}]);
  expect(result).toMatchObject({
    skills: [
      expect.objectContaining({
        name: "inspect-project",
        body: "# 检查",
        scope: "plugin",
        enabled: true,
        pluginId: installed.installed.id,
        path: "",
      }),
    ],
  });
  const catalog = createSkillCatalogService({
    localInstance,
    repository,
    plugins: f.registry,
  });
  const entries = await catalog.listSkills(f.instanceId, "code");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.fileCount).toBe(1);
  const ref = entries[0]?.name;
  if (!ref) throw new Error("未返回稳定技能身份");
  const load = createInstanceSkillsByInstanceLoader({
    skills: repository,
    plugins: f.registry,
  });
  const frozen = await load(f.instanceId);
  expect(frozen).toMatchObject([{ name: ref, path: ref, content: body }]);
  expect(renderSkillsSection(frozen)).toContain("use_skill");
  expect(renderSkillsSection(frozen)).not.toContain(
    "Read `kenfutwork-plugin-skill:",
  );
  expect(await catalog.getSkill(f.instanceId, ref, "code")).toMatchObject({
    content: body,
  });
  const resources = createInstanceSkillResourceReader({
    localInstance,
    repository,
    plugins: f.registry,
  });
  expect(
    await resources.read(f.instanceId, ref, "references/说明.md", "design"),
  ).toMatchObject({ content: "原资源😀", resourcePath: "references/说明.md" });
  await expect(
    resources.read(f.instanceId, ref, "../module.js", "code"),
  ).rejects.toThrow("canonical");
  await f.registry.setEnabled(installed.installed.id, false);
  expect(await load(f.instanceId)).toEqual([]);
  expect(frozen[0]?.content).toBe(body);
  expect(await listing.call(f.actor, [{}])).toMatchObject({
    skills: [expect.objectContaining({ enabled: false })],
  });
  expect((await catalog.listSkills(f.instanceId, "code"))[0]?.enabled).toBe(
    false,
  );
  expect(await catalog.getSkill(f.instanceId, ref, "code")).toBeUndefined();
  expect(
    await resources.read(f.instanceId, ref, "SKILL.md", "design"),
  ).toBeUndefined();
  await f.registry.uninstall(installed.installed.id);
  expect(await listing.call(f.actor, [{}])).toMatchObject({
    skills: [],
  });
});
