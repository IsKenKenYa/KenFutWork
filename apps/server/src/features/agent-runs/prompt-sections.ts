/**
 * 共享基础段（两模式恒挂）：身份、工具选择总则、错误处理总则、语言规则。
 * 模式专属指导（design 画布 / code 编码）在各自段落里，见 design.ts / code.ts。
 */
export const BASE_PROMPT = `你是 KenFutWork Agent，一个可爱活泼、乐于助人的 AI 助手，生活在 KenFutWork 工作台中 ✨

## 工具选择总则
- **纯文字任务**（问答、文章、翻译、方案讨论）→ 直接回复，**不调用**任何工具
- 只有用户明确要求产出物时才调用相应工具，讨论不要动手

## 错误处理总则
- 工具失败 → 告知用户发生了什么 + 下一步建议

## 语言
- **始终用用户的语言回复**：用户用中文（哪怕只夹了英文产品词/路径）就全程用中文，不要切换成英文
- 给子代理写任务说明（派发 description）同样用用户的语言
- 代码、命令、文件路径、专有名词保留原文即可

保持回复简洁友好 ✨`;

import type { PromptSectionDefinition } from "../../kernel/types.js";

/** 共享基础段：agent-runs 插件贡献（运行时属主），两模式恒挂。 */
export const basePromptSection: PromptSectionDefinition = {
  name: "base",
  order: -100,
  scope: "always",
  resolve: () => BASE_PROMPT,
};

/** 工作区技能段：渲染 run 已解析的技能清单（含关联文件目录统计）。 */
export function renderSkillsSection(
  skills: readonly {
    name: string;
    description: string;
    path: string;
    files: ReadonlyArray<{ path: string }>;
  }[],
): string | null {
  if (skills.length === 0) return null;
  const skillsList = skills
    .map((s) => {
      let line = `- **${s.name}**: ${s.description}\n  → Read \`${s.path}\` for full instructions`;
      if (s.files.length > 0) {
        const counts: Record<string, number> = {};
        for (const f of s.files) {
          const dir = f.path.split("/")[0] ?? "other";
          counts[dir] = (counts[dir] ?? 0) + 1;
        }
        const summary = Object.entries(counts)
          .map(([dir, n]) => `${dir}/ (${n})`)
          .join(", ");
        line += `\n  → Has: ${summary}`;
      }
      return line;
    })
    .join("\n");
  return `## Skills\n\nThe following skills are enabled in this workspace:\n${skillsList}`;
}

/** skills 段：workspaceSkills 为 run 起始期事实（composition ctx 携带）。 */
export const skillsPromptSection: PromptSectionDefinition = {
  name: "workspace.skills",
  order: 200,
  scope: "always",
  resolve: (ctx) => renderSkillsSection(ctx.workspaceSkills ?? []),
};

/**
 * 规则与插件提示段（最外层，order 300）：用户规则是 run 起始期事实
 * （runtime 读 settings 的同一趟顺带取出，经 ctx 携带——避免段内二次读库）；
 * 插件能力提示段由闭包自取（装/卸载后下一轮 run 即生效）。
 */
export function createRulesPromptSection(deps: {
  pluginFragments: () => string[];
}): PromptSectionDefinition {
  return {
    name: "workspace.rules-and-plugins",
    order: 300,
    scope: "always",
    resolve: (ctx) => {
      const parts: string[] = [];
      const rules = ctx.userRulesFragment ?? [];
      for (const rule of rules) {
        if (rule.trim().length > 0) parts.push(rule);
      }
      const fragments = deps
        .pluginFragments()
        .filter((section) => section.trim().length > 0);
      if (fragments.length > 0) {
        parts.push(`## 插件提示段\n\n${fragments.join("\n\n")}`);
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    },
  };
}
