import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createSkillCatalogRepository,
  createWorkspaceSkillSettingsRepository,
} from "../skills/repository.js";
import { createSkillCatalogService } from "../skills/skill-catalog-service.js";
import {
  type CodeUiHostTargetRequest,
  createCodeUiHostServicesRpc,
} from "./host-service-rpc.js";

function fixture() {
  const owner = randomUUID();
  const workspace = randomUUID();
  const foreignWorkspace = randomUUID();
  const skill = randomUUID();
  const otherSkill = randomUUID();
  const project = randomUUID();
  const actor = {
    id: owner,
    email: "skills@test",
    accessToken: "private",
    userMetadata: {},
  };
  const rows = new Map<
    string,
    Map<
      string,
      {
        enabled: boolean;
        id: string;
        slug: string;
        name: string;
        description: string;
        skill_content: string;
      }
    >
  >([
    [
      workspace,
      new Map([
        [
          skill,
          {
            enabled: true,
            id: skill,
            slug: "design-skill",
            name: "设计技能",
            description: "真实安装包",
            skill_content:
              "---\nname: design-skill\ndescription: 真实安装包\n---\n完整正文",
          },
        ],
      ]),
    ],
    [
      foreignWorkspace,
      new Map([
        [
          otherSkill,
          {
            enabled: true,
            id: otherSkill,
            slug: "foreign-secret",
            name: "其它工作区",
            description: "不可读",
            skill_content: "private foreign body",
          },
        ],
      ]),
    ],
  ]);
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    const workspaceRows = rows.get(String(values.at(-1)));
    if (sql.trimStart().startsWith("update")) {
      const record = workspaceRows?.get(String(values[0]));
      if (record) record.enabled = Boolean(values[1]);
      return { rowCount: record ? 1 : 0, rows: [] };
    }
    return {
      rowCount: workspaceRows?.size ?? 0,
      rows: [...(workspaceRows?.values() ?? [])],
    };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("skills夹具不建立宿主会话。");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  const skills = createSkillCatalogRepository(persistence);
  const requests: CodeUiHostTargetRequest[] = [];
  const rpc = createCodeUiHostServicesRpc({
    skills,
    skillSettings: createWorkspaceSkillSettingsRepository(persistence),
    resolveTarget: async (user, request) => {
      requests.push(request);
      if (
        user.id !== owner ||
        request.workspacePath !== "/owned-project" ||
        request.viewerScope?.kind !== "project" ||
        request.viewerScope.projectId !== project
      )
        throw new Error("项目/工作区viewer未授权。");
      return {
        workspaceId: workspace,
        projectId: project,
        rootDirectory: "/owned-project",
        viewerScope: request.viewerScope,
      };
    },
  });
  const params = {
    workspacePath: "/owned-project",
    viewerScope: { kind: "project" as const, projectId: project },
    provider: "zcode",
  };
  const connection = {
    connectionId: "owned-connection",
    workspaceId: workspace,
    userId: owner,
  };
  return {
    actor,
    workspace,
    foreignWorkspace,
    skill,
    otherSkill,
    rows,
    queries,
    skills,
    rpc,
    params,
    connection,
    requests,
  };
}

it("原ISkillsService list→toggle→共享Code技能正文读口径，真实workspace installed且没有假物理路径", async () => {
  const f = fixture();
  const before = await f.rpc.call(
    f.actor,
    "skills",
    "list",
    [f.params],
    f.connection,
  );
  expect(before).toMatchObject({
    result: {
      skills: [
        {
          id: f.skill,
          name: "design-skill",
          body: expect.stringContaining("完整正文"),
          path: "",
          scope: "workspace",
          enabled: true,
          resourceRef: expect.stringContaining(f.skill),
        },
      ],
      capability: { userScopeAvailable: false },
      diagnostics: [],
    },
  });
  await f.rpc.call(
    f.actor,
    "skills",
    "setEnabled",
    [{ ...f.params, skillId: f.skill, enabled: false, scope: "workspace" }],
    f.connection,
  );
  const catalog = createSkillCatalogService({ repository: f.skills });
  expect(await catalog.getSkill(f.workspace, "design-skill")).toBeUndefined();
  expect(
    await f.rpc.call(f.actor, "skills", "list", [f.params], f.connection),
  ).toMatchObject({ result: { skills: [{ enabled: false }] } });
  await f.rpc.call(
    f.actor,
    "skills",
    "setEnabled",
    [{ ...f.params, skillId: f.skill, enabled: true }],
    f.connection,
  );
  expect(await catalog.getSkill(f.workspace, "design-skill")).toMatchObject({
    content: expect.stringContaining("完整正文"),
  });
  expect(f.queries.every((entry) => entry.sql.includes("workspace_id"))).toBe(
    true,
  );
});

it("buildPromptContext只激活完整显式mention，停用与同名前缀不误命中", async () => {
  const f = fixture();
  for (const prompt of [
    "$design-skill-extra",
    "cost$design-skill",
    "$$design-skill",
  ]) {
    expect(
      await f.rpc.call(
        f.actor,
        "skills",
        "buildPromptContext",
        [{ ...f.params, prompt }],
        f.connection,
      ),
    ).toEqual({ result: { prompt, activatedSkillNames: [] } });
  }
  const prompt = "使用 $design-skill，并复查 $design-skill。";
  expect(
    await f.rpc.call(
      f.actor,
      "skills",
      "buildPromptContext",
      [{ ...f.params, prompt }],
      f.connection,
    ),
  ).toMatchObject({
    result: {
      prompt: expect.stringContaining("完整正文"),
      activatedSkillNames: ["design-skill"],
    },
  });
  await f.rpc.call(
    f.actor,
    "skills",
    "setEnabled",
    [{ ...f.params, skillId: f.skill, enabled: false }],
    f.connection,
  );
  expect(
    await f.rpc.call(
      f.actor,
      "skills",
      "buildPromptContext",
      [{ ...f.params, prompt }],
      f.connection,
    ),
  ).toEqual({ result: { prompt, activatedSkillNames: [] } });
});

it("其它viewer/connection/skillId不越工作区，不能由raw path签发技能目标", async () => {
  const f = fixture();
  await expect(
    f.rpc.call(
      f.actor,
      "skills",
      "list",
      [{ ...f.params, workspacePath: "/foreign" }],
      f.connection,
    ),
  ).rejects.toThrow(/授权/);
  await expect(
    f.rpc.call(f.actor, "skills", "list", [f.params], {
      ...f.connection,
      userId: "other",
    }),
  ).rejects.toThrow(/连接|身份/);
  await expect(
    f.rpc.call(
      f.actor,
      "skills",
      "setEnabled",
      [{ ...f.params, skillId: f.otherSkill, enabled: false }],
      f.connection,
    ),
  ).rejects.toThrow(/安装|不可见|不存在/);
  expect(f.rows.get(f.foreignWorkspace)?.get(f.otherSkill)?.enabled).toBe(true);
});

it("卸载后迟到toggle只update现有安装，不upsert复活", async () => {
  const f = fixture();
  f.rows.get(f.workspace)?.delete(f.skill);
  await expect(
    f.rpc.call(
      f.actor,
      "skills",
      "setEnabled",
      [{ ...f.params, skillId: f.skill, enabled: true }],
      f.connection,
    ),
  ).rejects.toThrow(/安装|不存在/);
  expect(f.rows.get(f.workspace)?.has(f.skill)).toBe(false);
  expect(f.queries.every((entry) => !entry.sql.includes("insert"))).toBe(true);
});

it("DB安装技能不可作为本地目录复制/删除；未实现的服务不制造成功", async () => {
  const f = fixture();
  await expect(
    f.rpc.call(
      f.actor,
      "skills",
      "copyToCommon",
      [{ ...f.params, skillId: f.skill }],
      f.connection,
    ),
  ).rejects.toThrow(/安装包|本地|资源/);
  expect(
    await f.rpc.call(f.actor, "unknown-service", "unknown", [], f.connection),
  ).toBeNull();
});
