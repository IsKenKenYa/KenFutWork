import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodeUiConnections } from "../code-ui/connections.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCodeUiSkillsHost } from "./code-ui-host.js";
import type { InstanceSkillRecord } from "./repository.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
});

const SKILL_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "00000000-0000-4000-8000-0000000000aa";
const PROJECT_ID = "00000000-0000-4000-8000-0000000000bb";
const WORKSPACE_PATH = "/work/project";

function createContext(actor: LocalActor) {
  const connections = new CodeUiConnections();
  const carrier = connections.open(
    actor.instanceId,
    actor.instanceId,
    async () => {},
    () => {},
    false,
    true,
    actor.accessClientId,
  );
  cleanup.push(() => void carrier.dispose());
  return connections.context(
    actor.instanceId,
    carrier.hello.connectionId,
    actor.accessClientId,
  );
}

function createHarness(
  options: {
    skillContent?: string;
    files?: { file_path: string; content: string }[];
    installed?: boolean;
    workspacePath?: string;
    commonSkillsRoot?: string;
    project?: { id: string; name: string } | null;
    projectRows?: { skillId: string; enabled: boolean; updatedAt: string }[];
  } = {},
) {
  const actor: LocalActor = Object.freeze({
    instanceId: INSTANCE_ID,
    accessClientId: null,
  });
  const localInstance = {
    async resolve() {
      return { instanceId: INSTANCE_ID };
    },
    async update() {
      throw new Error("测试不修改实例");
    },
    async assertOwned() {
      return INSTANCE_ID;
    },
  } as unknown as Parameters<typeof createCodeUiSkillsHost>[0]["localInstance"];
  const content = options.skillContent ?? "---\nname: writer\n---\n正文";
  const record: InstanceSkillRecord = {
    enabled: true,
    skillId: SKILL_ID,
    slug: "writer",
    name: "Writer",
    description: "写作用技能",
    skillContent: content,
    installationRevision: "2026-11-04 00:00:00",
  };
  const installed = options.installed ?? true;
  const upserts: Array<{
    instanceId: string;
    projectId: string;
    skillId: string;
    enabled: boolean;
  }> = [];
  const repository = {
    async listInstanceSkills() {
      return installed ? [record] : [];
    },
    async findVisibleById() {
      return {
        id: SKILL_ID,
        slug: "writer",
        name: "Writer",
        description: "写作用技能",
        skill_content: content,
      };
    },
    async listFilesForVisibleSkill() {
      return options.files ?? [];
    },
    async setEnabled() {
      return true;
    },
    async uninstall() {
      return 1;
    },
  };
  const projectSkills = {
    async findProject() {
      return options.project ?? null;
    },
    async listProjectSkills() {
      return options.projectRows ?? [];
    },
    async upsertProjectSkill(input: (typeof upserts)[number]) {
      upserts.push(input);
      return 1;
    },
    async setProjectSkillEnabled() {
      return true;
    },
  };
  const projects = {
    async findDirectoryProjects(_instanceId: string, path: string) {
      return options.project &&
        path === (options.workspacePath ?? WORKSPACE_PATH)
        ? [
            {
              id: options.project.id,
              kind: "design" as const,
              enabled_modes: ["design" as const],
              name: options.project.name,
              slug: "project",
              description: null,
              instance_id: INSTANCE_ID,
              brand_kit_id: null,
              created_at: "",
              updated_at: "",
              work_dir: path,
              additional_directories: [],
            },
          ]
        : [];
    },
  };
  const host = createCodeUiSkillsHost({
    localInstance,
    repository,
    plugins: { readSkillPackages: async () => [] },
    projectSkills,
    projects,
    ...(options.commonSkillsRoot
      ? { commonSkillsRoot: options.commonSkillsRoot }
      : {}),
  });
  return { actor, host, context: createContext(actor), upserts };
}

function createCommonRoot() {
  const root = mkdtempSync(join(tmpdir(), "kfw-skill-common-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

it("复制到通用目录写入完整技能包，重放返回同一路径，内容不同则冲突", async () => {
  const root = createCommonRoot();
  const f = createHarness({
    commonSkillsRoot: root,
    files: [{ file_path: "scripts/check.ts", content: "export const ok = 1;" }],
  });
  const copy = f.host["skills.copyToCommon"];
  if (!copy) throw new Error("复制入口未注册");
  const first = await copy.call(f.actor, [{ skillId: SKILL_ID }], f.context);
  expect(first).toEqual({ newPath: join(root, "writer") });
  const replay = await copy.call(f.actor, [{ skillId: SKILL_ID }], f.context);
  expect(replay).toEqual({ newPath: join(root, "writer") });

  const changed = createHarness({
    commonSkillsRoot: root,
    skillContent: "---\nname: writer\n---\n改过",
  });
  const conflictCopy = changed.host["skills.copyToCommon"];
  if (!conflictCopy) throw new Error("复制入口未注册");
  await expect(
    conflictCopy.call(changed.actor, [{ skillId: SKILL_ID }], changed.context),
  ).rejects.toMatchObject({
    code: "skill_common_conflict",
    statusCode: 409,
    message: "通用目录已有同名技能，内容不同。",
  });
});

it("从通用目录移除已复制技能，重复移除与内容变化都返回可读原因", async () => {
  const root = createCommonRoot();
  const f = createHarness({ commonSkillsRoot: root });
  const copy = f.host["skills.copyToCommon"];
  const remove = f.host["skills.removeFromCommon"];
  if (!copy || !remove) throw new Error("通用目录入口未注册");
  await copy.call(f.actor, [{ skillId: SKILL_ID }], f.context);
  await expect(
    remove.call(f.actor, [{ skillId: SKILL_ID }], f.context),
  ).resolves.toBeNull();
  await expect(
    remove.call(f.actor, [{ skillId: SKILL_ID }], f.context),
  ).rejects.toMatchObject({
    code: "skill_not_in_common",
    statusCode: 409,
    message: "通用目录里没有这个技能。",
  });

  const tampered = createHarness({
    commonSkillsRoot: root,
    skillContent: "---\nname: writer\n---\n另一个正文",
  });
  const tamperedCopy = tampered.host["skills.copyToCommon"];
  if (!tamperedCopy) throw new Error("复制入口未注册");
  await tamperedCopy.call(
    tampered.actor,
    [{ skillId: SKILL_ID }],
    tampered.context,
  );
  await expect(
    remove.call(f.actor, [{ skillId: SKILL_ID }], f.context),
  ).rejects.toMatchObject({
    code: "skill_common_conflict",
    statusCode: 409,
    message: "通用目录的同名技能内容不同，已拒绝移除。",
  });
});

it("未配置通用目录、技能已删除与目录名越界都返回可读原因", async () => {
  const noRoot = createHarness();
  const copy = noRoot.host["skills.copyToCommon"];
  if (!copy) throw new Error("复制入口未注册");
  await expect(
    copy.call(noRoot.actor, [{ skillId: SKILL_ID }], noRoot.context),
  ).rejects.toMatchObject({
    code: "skill_common_unavailable",
    statusCode: 501,
    message: "未配置通用技能目录。",
  });

  const root = createCommonRoot();
  const missing = createHarness({ commonSkillsRoot: root });
  const repository = {
    async findVisibleById() {
      return null;
    },
  };
  const host = createCodeUiSkillsHost({
    localInstance: {
      async resolve() {
        return { instanceId: INSTANCE_ID };
      },
    } as unknown as Parameters<
      typeof createCodeUiSkillsHost
    >[0]["localInstance"],
    repository: {
      ...repository,
      listInstanceSkills: async () => [],
      listFilesForVisibleSkill: async () => [],
      setEnabled: async () => false,
      uninstall: async () => 0,
    },
    plugins: { readSkillPackages: async () => [] },
    projectSkills: {
      findProject: async () => null,
      listProjectSkills: async () => [],
      upsertProjectSkill: async () => 0,
      setProjectSkillEnabled: async () => false,
    },
    projects: { findDirectoryProjects: async () => [] },
    commonSkillsRoot: root,
  });
  const missingCopy = host["skills.copyToCommon"];
  if (!missingCopy) throw new Error("复制入口未注册");
  await expect(
    missingCopy.call(missing.actor, [{ skillId: SKILL_ID }], missing.context),
  ).rejects.toMatchObject({
    code: "skill_not_found",
    statusCode: 404,
    message: "技能不存在或已删除，请刷新列表。",
  });

  const unsafe = createHarness({ commonSkillsRoot: root });
  const unsafeHost = createCodeUiSkillsHost({
    localInstance: {
      async resolve() {
        return { instanceId: INSTANCE_ID };
      },
    } as unknown as Parameters<
      typeof createCodeUiSkillsHost
    >[0]["localInstance"],
    repository: {
      listInstanceSkills: async () => [],
      listFilesForVisibleSkill: async () => [],
      setEnabled: async () => false,
      uninstall: async () => 0,
      findVisibleById: async () => ({
        id: SKILL_ID,
        slug: "../escape",
        skill_content: "正文",
      }),
    },
    plugins: { readSkillPackages: async () => [] },
    projectSkills: {
      findProject: async () => null,
      listProjectSkills: async () => [],
      upsertProjectSkill: async () => 0,
      setProjectSkillEnabled: async () => false,
    },
    projects: { findDirectoryProjects: async () => [] },
    commonSkillsRoot: root,
  });
  const unsafeCopy = unsafeHost["skills.copyToCommon"];
  if (!unsafeCopy) throw new Error("复制入口未注册");
  await expect(
    unsafeCopy.call(unsafe.actor, [{ skillId: SKILL_ID }], unsafe.context),
  ).rejects.toMatchObject({
    code: "skill_package_unreadable",
    statusCode: 500,
  });
});

it("项目作用域按真实目录解析项目写入，未关联项目或未安装都拒绝", async () => {
  const f = createHarness({ project: { id: PROJECT_ID, name: "项目甲" } });
  const toggle = f.host["skills.setEnabled"];
  if (!toggle) throw new Error("启停入口未注册");
  await toggle.call(
    f.actor,
    [
      {
        skillId: SKILL_ID,
        installationRevision: "2026-11-04 00:00:00",
        enabled: false,
        scope: "workspace",
        workspacePath: WORKSPACE_PATH,
      },
    ],
    f.context,
  );
  expect(f.upserts).toEqual([
    {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      skillId: SKILL_ID,
      enabled: false,
    },
  ]);

  const noProject = createHarness();
  const noProjectToggle = noProject.host["skills.setEnabled"];
  if (!noProjectToggle) throw new Error("启停入口未注册");
  await expect(
    noProjectToggle.call(
      noProject.actor,
      [
        {
          skillId: SKILL_ID,
          installationRevision: "2026-11-04 00:00:00",
          enabled: true,
          scope: "workspace",
          workspacePath: "/work/other",
        },
      ],
      noProject.context,
    ),
  ).rejects.toMatchObject({
    code: "skill_project_unavailable",
    statusCode: 404,
    message: "当前目录未关联项目，无法设置项目技能。",
  });

  const notInstalled = createHarness({
    project: { id: PROJECT_ID, name: "项目甲" },
    installed: false,
  });
  const notInstalledToggle = notInstalled.host["skills.setEnabled"];
  if (!notInstalledToggle) throw new Error("启停入口未注册");
  await expect(
    notInstalledToggle.call(
      notInstalled.actor,
      [
        {
          skillId: SKILL_ID,
          installationRevision: "2026-11-04 00:00:00",
          enabled: true,
          scope: "workspace",
          workspacePath: WORKSPACE_PATH,
        },
      ],
      notInstalled.context,
    ),
  ).rejects.toMatchObject({
    code: "skill_not_installed",
    statusCode: 404,
  });
});

it("项目设置只返回已安装技能，解析不到项目时返回空，插件技能不能启停", async () => {
  const f = createHarness({
    project: { id: PROJECT_ID, name: "项目甲" },
    projectRows: [
      { skillId: SKILL_ID, enabled: true, updatedAt: "2026-11-04 00:00:00" },
      {
        skillId: "00000000-0000-4000-8000-000000000002",
        enabled: true,
        updatedAt: "2026-11-04 00:00:00",
      },
    ],
  });
  const settings = f.host["skills.projectSettings"];
  if (!settings) throw new Error("项目设置入口未注册");
  expect(
    await settings.call(
      f.actor,
      [{ workspacePath: WORKSPACE_PATH }],
      f.context,
    ),
  ).toEqual({
    projectId: PROJECT_ID,
    projectName: "项目甲",
    skills: [
      { skillId: SKILL_ID, enabled: true, updatedAt: "2026-11-04 00:00:00" },
    ],
  });

  const noProject = createHarness();
  const noProjectSettings = noProject.host["skills.projectSettings"];
  if (!noProjectSettings) throw new Error("项目设置入口未注册");
  expect(
    await noProjectSettings.call(
      noProject.actor,
      [{ workspacePath: WORKSPACE_PATH }],
      noProject.context,
    ),
  ).toEqual({ projectId: null, projectName: null, skills: [] });

  const toggle = f.host["skills.setEnabled"];
  if (!toggle) throw new Error("启停入口未注册");
  await expect(
    toggle.call(
      f.actor,
      [
        {
          skillId: SKILL_ID,
          installationRevision: "2026-11-04 00:00:00",
          enabled: true,
          scope: "plugin",
        },
      ],
      f.context,
    ),
  ).rejects.toMatchObject({
    code: "skill_scope_readonly",
    statusCode: 400,
    message: "插件技能由插件管理，不能单独启停。",
  });
});
