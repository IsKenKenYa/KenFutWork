import { describe, expect, it } from "vitest";

import type { WorkspaceSkillEntry } from "../workspace-skills.js";
import { KENFUTWORK_BASE_PROMPT } from "./base.js";
import { KENFUTWORK_CODE_PROMPT } from "./code.js";
import { composeSystemPrompt } from "./compose.js";
import { KENFUTWORK_DESIGN_PROMPT } from "./design.js";

/**
 * 模式能力分离的提示契约（DEC-2 收敛）：两模式共享 base 段与 Skills/插件段，
 * 模式段互斥——code 提示不含任何画布/生图指导，design 提示不含编码指导。
 * 任何一段串味，这组断言先红。
 */

const NO_INPUTS = {
  workspaceSkills: [],
  systemPromptExtras: [],
} as const;

describe("composeSystemPrompt（模式段互斥）", () => {
  it("code：含编码指导段，不含画布/生图/品牌指导", () => {
    const prompt = composeSystemPrompt({ preset: "code", ...NO_INPUTS });

    expect(prompt).toContain(KENFUTWORK_BASE_PROMPT);
    expect(prompt).toContain(KENFUTWORK_CODE_PROMPT);
    expect(prompt).not.toContain(KENFUTWORK_DESIGN_PROMPT);

    // 画布能力的标志性内容一行都不许出现
    for (const forbidden of [
      "manipulate_canvas 操作",
      "画布感知",
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
    // 编码指导的标志性内容必须在
    for (const required of [
      "工作目录就是项目本身",
      "execute_background",
      "检查点",
      "explore",
      "review",
    ]) {
      expect(prompt, `code 提示应包含「${required}」`).toContain(required);
    }
  });

  it("design：含画布指导段，不含编码专属指导", () => {
    const prompt = composeSystemPrompt({ preset: "design", ...NO_INPUTS });

    expect(prompt).toContain(KENFUTWORK_BASE_PROMPT);
    expect(prompt).toContain(KENFUTWORK_DESIGN_PROMPT);
    expect(prompt).not.toContain(KENFUTWORK_CODE_PROMPT);

    for (const forbidden of [
      "工作目录就是项目本身",
      "execute_background",
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
      "## 绘制顺序",
    ]) {
      expect(prompt, `design 提示应包含「${required}」`).toContain(required);
    }
  });

  it("品牌套件段仅 design 且已绑定时出现", () => {
    const designBound = composeSystemPrompt({
      preset: "design",
      brandKitId: "kit-1",
      ...NO_INPUTS,
    });
    const designUnbound = composeSystemPrompt({
      preset: "design",
      brandKitId: null,
      ...NO_INPUTS,
    });
    const codeBound = composeSystemPrompt({
      preset: "code",
      brandKitId: "kit-1",
      ...NO_INPUTS,
    });

    expect(designBound).toContain("当前项目已绑定品牌套件");
    expect(designUnbound).not.toContain("当前项目已绑定品牌套件");
    expect(codeBound).not.toContain("当前项目已绑定品牌套件");
  });

  it("Skills 段与插件提示段两模式都挂，空段不产生空标题", () => {
    const skills: WorkspaceSkillEntry[] = [
      {
        name: "调研",
        description: "查资料",
        path: "/workspace-skills/调研/SKILL.md",
        content: "# 调研",
        files: [
          { path: "references/a.md", content: "a" },
          { path: "references/b.md", content: "b" },
          { path: "scripts/x.ts", content: "x" },
        ],
      },
    ];
    for (const preset of ["design", "code"] as const) {
      const withAll = composeSystemPrompt({
        preset,
        workspaceSkills: skills,
        systemPromptExtras: ["插件甲的行为引导", "  "],
      });
      expect(withAll).toContain("## Skills");
      expect(withAll).toContain("- **调研**: 查资料");
      expect(withAll).toContain("references/ (2), scripts/ (1)");
      // 空白插件段被过滤，不产生孤立标题
      expect(withAll).toContain("## 插件提示段\n\n插件甲的行为引导");

      const bare = composeSystemPrompt({ preset, ...NO_INPUTS });
      expect(bare).not.toContain("## Skills");
      expect(bare).not.toContain("## 插件提示段");
    }
  });
});
