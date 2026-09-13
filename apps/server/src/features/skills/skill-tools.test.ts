import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createSkillsPlugin } from "./plugin.js";
import type { SkillCatalogRepository } from "./repository.js";
import {
  createSkillCatalogService,
  type SkillCatalogEntry,
} from "./skill-catalog-service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const skillRows = [
  {
    enabled: true,
    skillId: "s1",
    slug: "canvas-design",
    name: "Canvas Design",
    description: "海报生成技能",
    skillContent: "---\nname: canvas-design\n---\n步骤…",
  },
  {
    enabled: false,
    skillId: "s2",
    slug: "json-image-prompt",
    name: "JSON Image Prompt",
    description: "提示词技能",
    skillContent: "---\nname: json-image-prompt\n---\n停用中",
  },
];

function fakeRepository(
  rows: typeof skillRows = skillRows,
): SkillCatalogRepository {
  return {
    listSkillFiles: async () => [],
    listWorkspaceSkills: async () => rows,
  };
}

/** 数据库形状的原始行（repository 负责映射为领域对象）。 */
const rawSkillRows = [
  {
    enabled: true,
    id: "s1",
    slug: "canvas-design",
    name: "Canvas Design",
    description: "海报生成技能",
    skill_content: "---\nname: canvas-design\n---\n步骤…",
  },
  {
    enabled: false,
    id: "s2",
    slug: "json-image-prompt",
    name: "JSON Image Prompt",
    description: "提示词技能",
    skill_content: "---\nname: json-image-prompt\n---\n停用中",
  },
];

/** 记录型假 persistence：断言工具把 execCtx.workspaceId 透传到了数据访问。 */
function fakePersistence() {
  const scopes: string[] = [];

  const makeClient = (workspaceId?: string) => ({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    async query() {
      if (workspaceId !== undefined) {
        scopes.push(workspaceId);
      }
      return rawSkillRows;
    },
    async queryOne() {
      return null;
    },
    async execute() {
      return 0;
    },
  });

  return {
    scopes,
    service: {
      ...makeClient(),
      forWorkspace: (workspaceId: string) => makeClient(workspaceId),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ ...makeClient(), forWorkspace: (id: string) => makeClient(id) }),
      ping: async () => {},
      close: async () => {},
    } as never,
  };
}

describe("skill 目录服务（SKILL.md 发现缝）", () => {
  it("按工作区列出 skill（含停用，工具侧自行过滤）", async () => {
    const catalog = createSkillCatalogService({
      repository: fakeRepository(),
    });
    const entries: SkillCatalogEntry[] = await catalog.listSkills("ws-1");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "canvas-design",
      description: "海报生成技能",
      enabled: true,
    });
    expect(entries[1]?.enabled).toBe(false);
  });

  it("getSkill 返回启用的 SKILL.md 全文；停用/未知返回 undefined", async () => {
    const catalog = createSkillCatalogService({
      repository: fakeRepository(),
    });

    const detail = await catalog.getSkill("ws-1", "canvas-design");
    expect(detail?.content).toContain("步骤");
    expect(await catalog.getSkill("ws-1", "json-image-prompt")).toBeUndefined();
    expect(await catalog.getSkill("ws-1", "ghost")).toBeUndefined();

    const empty = createSkillCatalogService({
      repository: fakeRepository([]),
    });
    expect(await empty.listSkills("ws-1")).toEqual([]);
    expect(await empty.getSkill("ws-1", "canvas-design")).toBeUndefined();
  });

  it("数据访问失败按「无 skill」降级，不炸工具链", async () => {
    const catalog = createSkillCatalogService({
      repository: {
        listSkillFiles: async () => [],
        listWorkspaceSkills: async () => {
          throw new Error("connection reset");
        },
      },
    });

    await expect(catalog.listSkills("ws-1")).resolves.toEqual([]);
    await expect(
      catalog.getSkill("ws-1", "canvas-design"),
    ).resolves.toBeUndefined();
  });
});

describe("skills 插件向 ctx.tools 贡献工具（P5 缝）", () => {
  function kernelWithSkillsPlugin() {
    const app = Fastify({ logger: false });
    const persistence = fakePersistence();
    const kernel = composePlugins(
      {
        agentBackendMode: "state" as const,
        agentModel: "m",
        port: 0,
        version: "t",
        webOrigin: "http://x",
      },
      [createSkillsPlugin({ createUserClient: (() => ({})) as never })],
      {
        app,
        overrides: {
          auth: { authenticate: async () => null },
          persistence: persistence.service,
          viewer: {} as never,
        },
      },
    );
    return { kernel, persistence };
  }

  it("注册 list_skills / use_skill（shared scope）并按执行上下文的工作区取数", async () => {
    const { kernel, persistence } = kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");
    expect(tools.get("list_skills")?.scope).toBe("shared");
    expect(tools.get("use_skill")?.scope).toBe("shared");

    const listed = await tools.execute(
      "list_skills",
      {},
      { workspaceId: "ws-7" },
    );
    expect(listed).toEqual({
      skills: [{ name: "canvas-design", description: "海报生成技能" }],
    });

    const detail = await tools.execute(
      "use_skill",
      { name: "canvas-design" },
      { workspaceId: "ws-7" },
    );
    expect((detail as { content: string }).content).toContain("步骤");

    // 回归锁：执行上下文里的工作区必须真的传到数据访问（曾因传空用户 id 恒空）
    expect(persistence.scopes).toEqual(["ws-7", "ws-7"]);
    kernel.dispose();
  });

  it("缺少工作区上下文时明示原因，不再静默返回空", async () => {
    const { kernel, persistence } = kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");

    expect(await tools.execute("list_skills", {}, {})).toEqual({
      skills: [],
      hint: expect.stringContaining("工作区"),
    });
    await expect(
      tools.execute("use_skill", { name: "canvas-design" }, {}),
    ).rejects.toThrow(/工作区/);
    expect(persistence.scopes).toEqual([]);
    kernel.dispose();
  });

  it("use_skill 缺 name 参数即报错", async () => {
    const { kernel } = kernelWithSkillsPlugin();
    await expect(
      kernel.get("tools").execute("use_skill", {}, { workspaceId: "ws-1" }),
    ).rejects.toThrow(/name/);
    kernel.dispose();
  });
});
