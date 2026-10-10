import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createPluginInventoryFixture } from "../code-ui/plugins.test-fixture.js";
import { createConsumerLocalAccessService } from "../local-access/test-consumer-service.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createSkillsPlugin } from "./plugin.js";
import type { SkillCatalogRepository } from "./repository.js";
import {
  createSkillCatalogService,
  type SkillCatalogEntry,
} from "./skill-catalog-service.js";

const pluginCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of pluginCleanups.splice(0)) await release();
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

/** 目录与安装态方法的空实现：桩只覆盖用例关心的那一个，其余走默认。 */
const CATALOG_DEFAULTS = {
  deleteOwnedById: async () => 0,
  findVisibleById: async () => null,
  findVisibleSkill: async () => null,
  insertFilesForOwnedSkill: async () => 0,
  insertOwned: async () => null,
  listFilesForVisibleSkill: async () => [],
  listInstalled: async () => [],
  listSkillFiles: async () => [],
  listVisible: async () => [],
  uninstall: async () => 0,
  updateOwnedById: async () => null,
  upsertInstallation: async () => {},
  setEnabled: async () => false,
};

function fakeRepository(
  rows: typeof skillRows = skillRows,
): SkillCatalogRepository {
  return {
    ...CATALOG_DEFAULTS,
    listInstanceSkills: async () => rows,
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

/** 记录型假 persistence：断言工具把 execCtx.instanceId 透传到了数据访问。 */
function fakePersistence(
  options: {
    listRows?: () => typeof rawSkillRows;
    readFiles?: () => Array<{
      skill_id: string;
      file_path: string;
      content: string;
    }>;
  } = {},
) {
  const scopes: string[] = [];

  const makeClient = (instanceId?: string) => ({
    ...(instanceId === undefined ? {} : { instanceId }),
    async query(sql: string) {
      if (instanceId !== undefined) {
        scopes.push(instanceId);
      }
      if (sql.includes("from public.skill_files"))
        return options.readFiles?.() ?? [];
      return options.listRows?.() ?? rawSkillRows;
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
      forInstance: (instanceId: string) => makeClient(instanceId),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ ...makeClient(), forInstance: (id: string) => makeClient(id) }),
      ping: async () => {},
      close: async () => {},
    } as never,
  };
}

describe("skill 目录服务（SKILL.md 发现缝）", () => {
  it("按实例列出 skill（含停用，工具侧自行过滤）", async () => {
    const catalog = createSkillCatalogService({
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => "ws-1" },
        dataDir: "/tmp/skill-catalog-test",
      }),
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
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => "ws-1" },
        dataDir: "/tmp/skill-catalog-test",
      }),
      repository: fakeRepository(),
    });

    const detail = await catalog.getSkill("ws-1", "canvas-design");
    expect(detail?.content).toContain("步骤");
    expect(await catalog.getSkill("ws-1", "json-image-prompt")).toBeUndefined();
    expect(await catalog.getSkill("ws-1", "ghost")).toBeUndefined();

    const empty = createSkillCatalogService({
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => "ws-1" },
        dataDir: "/tmp/skill-catalog-test",
      }),
      repository: fakeRepository([]),
    });
    expect(await empty.listSkills("ws-1")).toEqual([]);
    expect(await empty.getSkill("ws-1", "canvas-design")).toBeUndefined();
  });

  it("数据访问故障如实传播，不伪装成空目录", async () => {
    const catalog = createSkillCatalogService({
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => "ws-1" },
        dataDir: "/tmp/skill-catalog-test",
      }),
      repository: {
        ...CATALOG_DEFAULTS,
        listInstanceSkills: async () => {
          throw new Error("connection reset");
        },
      },
    });

    await expect(catalog.listSkills("ws-1")).rejects.toThrow(
      "connection reset",
    );
    await expect(catalog.getSkill("ws-1", "canvas-design")).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("skills 插件向 ctx.tools 贡献工具（P5 缝）", () => {
  async function kernelWithSkillsPlugin(
    options: Parameters<typeof fakePersistence>[0] = {},
  ) {
    const app = Fastify({ logger: false });
    const persistence = fakePersistence(options);
    const inventory = await createPluginInventoryFixture();
    pluginCleanups.push(inventory.dispose);
    const kernel = composePlugins(
      {
        agentBackendMode: "state" as const,
        agentModel: "m",
        port: 0,
        version: "t",
        webOrigin: "http://x",
      },
      [
        createSkillsPlugin(),
        {
          name: "late-package-registry",
          inject: [],
          apply(ctx) {
            ctx.register("plugins", () => inventory.registry);
          },
        },
      ],
      {
        app,
        overrides: {
          localAccess: createConsumerLocalAccessService(),
          persistence: persistence.service,
          localInstance: createLocalInstanceService({
            repository: { ensure: async () => "ws-7" },
            dataDir: "/tmp/skill-plugin-test",
          }),
          projects: {
            getProject: async () => {
              throw new Error("未配置项目");
            },
          } as never,
          executionScopes: {
            openTask: async () => {
              throw new Error("未配置 Task");
            },
          } as never,
        },
      },
    );
    return { kernel, persistence };
  }

  it("注册 list_skills / use_skill（shared scope）并按执行上下文的实例取数", async () => {
    const { kernel, persistence } = await kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");
    expect(tools.get("list_skills")?.scope).toBe("shared");
    expect(tools.get("use_skill")?.scope).toBe("shared");

    const listed = await tools.execute(
      "list_skills",
      {},
      {
        instanceId: "ws-7",
        actor: { instanceId: "ws-7", accessClientId: null },
      },
    );
    expect(listed).toEqual({
      skills: [{ name: "canvas-design", description: "海报生成技能" }],
    });

    const detail = await tools.execute(
      "use_skill",
      { name: "canvas-design" },
      {
        instanceId: "ws-7",
        actor: { instanceId: "ws-7", accessClientId: null },
      },
    );
    expect((detail as { content: string }).content).toContain("步骤");

    // 回归锁：执行上下文里的实例必须真的传到数据访问（曾因传空用户 id 恒空）
    expect(persistence.scopes).toEqual(["ws-7", "ws-7"]);
    kernel.dispose();
  });

  it("缺少实例上下文时明示原因，不再静默返回空", async () => {
    const { kernel, persistence } = await kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");

    await expect(tools.execute("list_skills", {}, {})).rejects.toThrow(/可信/);
    await expect(
      tools.execute("use_skill", { name: "canvas-design" }, {}),
    ).rejects.toThrow(/可信/);
    expect(persistence.scopes).toEqual([]);
    kernel.dispose();
  });

  it("use_skill 缺 name 参数即报错", async () => {
    const { kernel } = await kernelWithSkillsPlugin();
    await expect(
      kernel.get("tools").execute("use_skill", {}, { instanceId: "ws-1" }),
    ).rejects.toThrow(/name/);
    kernel.dispose();
  });

  it("原use_skill消费真实DB附属资源，路径与可信Task实例均核对", async () => {
    const { kernel, persistence } = await kernelWithSkillsPlugin({
      readFiles: () => [
        {
          skill_id: "s1",
          file_path: "scripts/check.ts",
          content: "真实只读脚本",
        },
      ],
    });
    const tools = kernel.get("tools");
    try {
      expect(
        await tools.execute(
          "use_skill",
          { name: "canvas-design", resource_path: "scripts/check.ts" },
          {
            instanceId: "ws-7",
            actor: { instanceId: "ws-7", accessClientId: null },
          },
        ),
      ).toEqual({
        name: "canvas-design",
        resourceRef: "kenfutwork-skill:s1",
        resourcePath: "scripts/check.ts",
        content: "真实只读脚本",
      });
      expect(
        await tools.execute(
          "use_skill",
          { name: "canvas-design", resource_path: "SKILL.md" },
          {
            instanceId: "ws-7",
            actor: { instanceId: "ws-7", accessClientId: null },
          },
        ),
      ).toMatchObject({ content: expect.stringContaining("步骤") });
      const before = persistence.scopes.length;
      const useSkill = tools.get("use_skill");
      if (!useSkill) throw new Error("use_skill工具未注册。");
      await expect(
        useSkill.execute(
          { name: "canvas-design", resource_path: "scripts/check.ts" },
          {
            instanceId: "ws-7",
            actor: { instanceId: "ws-7", accessClientId: null },
            scopeHandle: {
              describe: () => ({ instanceId: "foreign" }),
            } as never,
          },
        ),
      ).rejects.toThrow(/实例|工作域/);
      for (const path of [
        "../outside",
        "/absolute",
        "C:/outside",
        "scripts//check.ts",
        "scripts/./check.ts",
        "scripts/check.ts\0",
      ]) {
        await expect(
          tools.execute(
            "use_skill",
            { name: "canvas-design", resource_path: path },
            {
              instanceId: "ws-7",
              actor: { instanceId: "ws-7", accessClientId: null },
            },
          ),
        ).rejects.toThrow(/路径|资源/);
      }
      expect(persistence.scopes.length).toBe(before);
    } finally {
      await kernel.dispose();
    }
  });

  it("资源查询完成前卸载或停用技能，迟到use_skill不能返回已撤回正文", async () => {
    for (const uninstall of [false, true]) {
      let installed = true;
      let enabled = true;
      const { kernel } = await kernelWithSkillsPlugin({
        listRows: () => {
          const row = rawSkillRows[0];
          if (!row) throw new Error("技能fixture缺少启用行。");
          return installed ? [{ ...row, enabled }] : [];
        },
        readFiles: () => {
          if (uninstall) installed = false;
          else enabled = false;
          return [
            {
              skill_id: "s1",
              file_path: "scripts/check.ts",
              content: "不得返回的迟到资源",
            },
          ];
        },
      });
      try {
        await expect(
          kernel.get("tools").execute(
            "use_skill",
            { name: "canvas-design", resource_path: "scripts/check.ts" },
            {
              instanceId: "ws-7",
              actor: { instanceId: "ws-7", accessClientId: null },
            },
          ),
        ).rejects.toThrow(/安装|停用|存在/);
      } finally {
        await kernel.dispose();
      }
    }
  });
});
