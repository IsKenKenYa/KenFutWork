import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composePlugins } from "../../kernel/compose.js";
import type { ToolRegistry } from "../../kernel/types.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import { createSkillsPlugin } from "./plugin.js";
import {
  createSkillCatalogService,
  type SkillCatalogEntry,
} from "./skill-catalog-service.js";

const user: AuthenticatedUser = {
  accessToken: "token",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

type AnyClient = Parameters<
  Parameters<typeof createSkillCatalogService>[0]["createUserClient"]
>[0];

/** 可编程的假 supabase 客户端：覆盖 catalog 用到的查询链。 */
function fakeClient(options: {
  workspaceId?: string;
  skillRows?: Array<Record<string, unknown>>;
}): AnyClient {
  const from = vi.fn((table: string) => {
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: options.workspaceId
                    ? { id: options.workspaceId }
                    : null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    // workspace_skills：select → eq(workspace_id) 即查询
    return {
      select: () => ({
        eq: () => Promise.resolve({ data: options.skillRows ?? [] }),
      }),
    };
  });
  return { from } as unknown as AnyClient;
}

const skillRow = {
  enabled: true,
  skill: {
    id: "s1",
    slug: "canvas-design",
    name: "Canvas Design",
    description: "海报生成技能",
    skill_content: "---\nname: canvas-design\n---\n步骤…",
  },
};

describe("skill 目录服务（SKILL.md 发现缝）", () => {
  it("列出工作区启用/停用的 skill", async () => {
    const disabled = {
      enabled: false,
      skill: { ...skillRow.skill, slug: "json-image-prompt" },
    };
    const catalog = createSkillCatalogService({
      createUserClient: () =>
        fakeClient({
          workspaceId: "ws-1",
          skillRows: [skillRow, disabled],
        }) as never,
    });
    const entries: SkillCatalogEntry[] = await catalog.listSkills(user);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "canvas-design",
      enabled: true,
    });
    expect(entries[1]?.enabled).toBe(false);
  });

  it("getSkill 返回启用的 SKILL.md 全文；停用/未知返回 undefined", async () => {
    const catalog = createSkillCatalogService({
      createUserClient: () =>
        fakeClient({ workspaceId: "ws-1", skillRows: [skillRow] }) as never,
    });
    const detail = await catalog.getSkill(user, "canvas-design");
    expect(detail?.content).toContain("canvas-design");
    expect(await catalog.getSkill(user, "ghost")).toBeUndefined();

    const empty = createSkillCatalogService({
      createUserClient: () => fakeClient({ skillRows: [] }) as never,
    });
    expect(await empty.getSkill(user, "canvas-design")).toBeUndefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skills 插件向 ctx.tools 贡献工具（P5 缝）", () => {
  function kernelWithSkillsPlugin() {
    const app = Fastify({ logger: false });
    return composePlugins(
      {
        agentBackendMode: "state" as const,
        agentModel: "m",
        port: 0,
        version: "t",
        webOrigin: "http://x",
      },
      [
        createSkillsPlugin({
          createUserClient: (() =>
            fakeClient({
              workspaceId: "ws-1",
              skillRows: [skillRow],
            })) as never,
        }),
      ],
      {
        app,
        overrides: {
          auth: { authenticate: async () => null },
          viewer: {} as never,
        },
      },
    );
  }

  it("注册 list_skills / use_skill（shared scope）且可执行", async () => {
    const kernel = kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");
    expect(tools.get("list_skills")?.scope).toBe("shared");
    expect(tools.get("use_skill")?.scope).toBe("shared");

    const listed = await tools.execute(
      "list_skills",
      {},
      {
        accessToken: "token",
      },
    );
    expect(listed).toEqual({
      skills: [{ name: "canvas-design", description: "海报生成技能" }],
    });

    const detail = await tools.execute(
      "use_skill",
      { name: "canvas-design" },
      { accessToken: "token" },
    );
    expect((detail as { content: string }).content).toContain("步骤");
    kernel.dispose();
  });

  it("缺少执行上下文令牌时优雅降级/报错", async () => {
    const kernel = kernelWithSkillsPlugin();
    const tools: ToolRegistry = kernel.get("tools");
    expect(await tools.execute("list_skills", {}, {})).toEqual({
      skills: [],
      hint: expect.stringContaining("用户令牌"),
    });
    await expect(
      tools.execute("use_skill", { name: "canvas-design" }, {}),
    ).rejects.toThrow(/用户令牌/);
    kernel.dispose();
  });
});
