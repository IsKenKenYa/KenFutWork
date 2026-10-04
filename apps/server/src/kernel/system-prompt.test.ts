import { describe, expect, it } from "vitest";
import {
  basePromptSection,
  createRulesPromptSection,
  renderSkillsSection,
  skillsPromptSection,
} from "../features/agent-runs/prompt-sections.js";
import { brandKitPromptSection } from "../features/brand-kit/prompt.js";
import { canvasDesignPromptSection } from "../features/canvas/prompt.js";
import { codeModePromptSection } from "../features/code-tools/prompt.js";
import { SystemPromptRegistryImpl } from "./context.js";
import type { PromptSectionDefinition } from "./types.js";

function section(input: Partial<PromptSectionDefinition> & { name: string }) {
  return {
    order: 0,
    scope: "always" as const,
    resolve: () => null,
    ...input,
  } satisfies PromptSectionDefinition;
}

describe("SystemPromptRegistryImpl（内核提示段注册表）", () => {
  it("scope 过滤：always 恒挂，design/code 按 preset 互斥", async () => {
    const registry = new SystemPromptRegistryImpl();
    registry.register(
      section({ name: "a", scope: "always", resolve: () => "BASE" }),
    );
    registry.register(
      section({ name: "d", scope: "design", resolve: () => "DESIGN" }),
    );
    registry.register(
      section({ name: "c", scope: "code", resolve: () => "CODE" }),
    );

    expect(await registry.compose({ preset: "design" })).toBe("BASE\n\nDESIGN");
    expect(await registry.compose({ preset: "code" })).toBe("BASE\n\nCODE");
  });

  it("order 升序拼装；同 order 按注册序；null/空白段剔除", async () => {
    const registry = new SystemPromptRegistryImpl();
    registry.register(section({ name: "late", order: 10, resolve: () => "L" }));
    registry.register(
      section({ name: "early", order: -5, resolve: () => "E" }),
    );
    registry.register(section({ name: "mid1", order: 0, resolve: () => "M1" }));
    registry.register(section({ name: "mid2", order: 0, resolve: () => "M2" }));
    registry.register(
      section({ name: "blank", order: 1, resolve: () => "  " }),
    );
    registry.register(section({ name: "gone", order: 2, resolve: () => null }));

    expect(await registry.compose({ preset: "code" })).toBe(
      "E\n\nM1\n\nM2\n\nL",
    );
  });

  it("重名 fail loud；disposer 注销后不再出现", async () => {
    const registry = new SystemPromptRegistryImpl();
    registry.register(section({ name: "dup", resolve: () => "x" }));
    expect(() =>
      registry.register(section({ name: "dup", resolve: () => "y" })),
    ).toThrow(/重复注册/);

    const dispose = registry.register(
      section({ name: "temp", resolve: () => "T" }),
    );
    dispose();
    expect(await registry.compose({ preset: "design" })).not.toContain("T");
  });

  it("resolve 可异步", async () => {
    const registry = new SystemPromptRegistryImpl();
    registry.register(
      section({
        name: "async",
        resolve: async () => {
          await Promise.resolve();
          return "ASYNC";
        },
      }),
    );
    expect(await registry.compose({ preset: "code" })).toBe("ASYNC");
  });
});

/**
 * 模式段互斥契约（原 prompts/compose.test.ts 的插件化版本）：
 * 注册各 feature 贡献的真实段定义后，code 组合产物不含画布/生图/品牌字眼，
 * design 组合产物不含编码指导——任何一段串味先红。
 */
describe("内置提示段的模式互斥（装配契约）", () => {
  function registryWithBuiltinSections() {
    const registry = new SystemPromptRegistryImpl();
    registry.register(basePromptSection);
    registry.register(canvasDesignPromptSection);
    registry.register(codeModePromptSection);
    registry.register(brandKitPromptSection);
    registry.register(skillsPromptSection);
    registry.register(
      createRulesPromptSection({ pluginFragments: () => ["插件甲的行为引导"] }),
    );
    return registry;
  }

  it("code：含编码指导段，不含画布/生图/品牌指导", async () => {
    const prompt = await registryWithBuiltinSections().compose({
      preset: "code",
      brandKitId: "kit-1",
      workspaceSkills: [],
    });

    for (const forbidden of [
      "画布感知",
      "manipulate_canvas 操作",
      "generate_image",
      "generate_video",
      "screenshot_canvas",
      "品牌套件",
      "## 颜色",
      "## 字号",
    ]) {
      expect(prompt, `code 提示不得包含「${forbidden}」`).not.toContain(
        forbidden,
      );
    }
    for (const required of [
      "Task 的主目录跨轮保持稳定",
      "后台工作归 Task",
      "检查点",
      "跟随用户的语言回复",
    ]) {
      expect(prompt, `code 提示应包含「${required}」`).toContain(required);
    }
  });

  it("design：含画布指导段（绑定品牌时含品牌段），不含编码专属指导", async () => {
    const prompt = await registryWithBuiltinSections().compose({
      preset: "design",
      brandKitId: "kit-1",
      workspaceSkills: [],
    });

    for (const forbidden of [
      "Task 的主目录跨轮保持稳定",
      "后台工作归 Task",
      "影子 git",
      "diff_files",
    ]) {
      expect(prompt, `design 提示不得包含「${forbidden}」`).not.toContain(
        forbidden,
      );
    }
    for (const required of [
      "画布感知",
      "manipulate_canvas 操作",
      "## 尺寸计算",
      "当前项目已绑定品牌套件",
    ]) {
      expect(prompt, `design 提示应包含「${required}」`).toContain(required);
    }

    // 未绑定品牌 → 品牌段隐去
    const unbound = await registryWithBuiltinSections().compose({
      preset: "design",
      workspaceSkills: [],
    });
    expect(unbound).not.toContain("当前项目已绑定品牌套件");
  });

  it("skills 段与规则/插件段两模式都挂，空态不产生空标题", async () => {
    const registry = registryWithBuiltinSections();
    for (const preset of ["design", "code"] as const) {
      const prompt = await registry.compose({
        preset,
        workspaceSkills: [
          {
            name: "调研",
            description: "查资料",
            path: "/workspace-skills/调研/SKILL.md",
            files: [{ path: "references/a.md" }, { path: "scripts/x.ts" }],
          },
        ],
        userRulesFragment: [
          "## 用户规则（用户显式设置，必须遵守）\n用中文回复",
        ],
      });
      expect(prompt).toContain("## Skills");
      expect(prompt).toContain("- **调研**: 查资料");
      expect(prompt).toContain("references/ (1), scripts/ (1)");
      expect(prompt).toContain("## 用户规则");
      expect(prompt).toContain("## 插件提示段\n\n插件甲的行为引导");
    }

    // 空态（无技能/无规则/无插件片段）：三个标题都不出现
    const bare = new SystemPromptRegistryImpl();
    bare.register(basePromptSection);
    bare.register(canvasDesignPromptSection);
    bare.register(codeModePromptSection);
    bare.register(brandKitPromptSection);
    bare.register(skillsPromptSection);
    bare.register(createRulesPromptSection({ pluginFragments: () => [] }));
    for (const preset of ["design", "code"] as const) {
      const prompt = await bare.compose({ preset, workspaceSkills: [] });
      expect(prompt).not.toContain("## Skills");
      expect(prompt).not.toContain("## 用户规则");
      expect(prompt).not.toContain("## 插件提示段");
    }
  });

  it("renderSkillsSection：空清单返回 null（不渲染空段）", () => {
    expect(renderSkillsSection([])).toBeNull();
  });
});
