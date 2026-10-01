import type { WorkspaceSkillEntry } from "../workspace-skills.js";
import { KENFUTWORK_BASE_PROMPT } from "./base.js";
import { KENFUTWORK_CODE_PROMPT } from "./code.js";
import { KENFUTWORK_DESIGN_PROMPT } from "./design.js";

/**
 * 系统提示组装（DEC-2 模式能力分离的唯一组装点）：
 *
 * 1. **base 段**（两模式恒挂）：身份、工具选择总则、错误处理总则、语言规则；
 * 2. **模式段**（design=画布指导 / code=编码指导）：按 preset 二选一；
 * 3. 品牌套件段：仅 design 且项目已绑定；
 * 4. Skills 段：两模式都挂（工作区启用的技能）；
 * 5. 插件提示段 + 用户规则：两模式都挂，接在最外层——插件是外部贡献，
 *    不该覆盖内置规则，只追加行为引导。
 *
 * 纯函数：deep-agent 只传参，组装规则的可测性集中在这里。
 */
export function composeSystemPrompt(input: {
  preset: "design" | "code";
  brandKitId?: string | null;
  workspaceSkills: readonly WorkspaceSkillEntry[];
  systemPromptExtras: readonly string[];
}): string {
  const modePrompt =
    input.preset === "design"
      ? KENFUTWORK_DESIGN_PROMPT
      : KENFUTWORK_CODE_PROMPT;

  let systemPrompt = `${KENFUTWORK_BASE_PROMPT}\n\n${modePrompt}`;

  // 品牌套件提示段仅 design（get_brand_kit 工具按 scope=design 过滤，提示同口径）
  if (input.brandKitId && input.preset === "design") {
    systemPrompt +=
      "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。";
  }

  // Inject enabled skills (both system and user-created) into the system prompt.
  // All skills are loaded from the database via loadWorkspaceSkills() in runtime.ts.
  if (input.workspaceSkills.length > 0) {
    const skillsList = input.workspaceSkills
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
    systemPrompt += `\n\n## Skills\n\nThe following skills are enabled in this workspace:\n${skillsList}`;
  }

  const extras = input.systemPromptExtras.filter(
    (section) => section.trim().length > 0,
  );
  if (extras.length > 0) {
    systemPrompt += `\n\n## 插件提示段\n\n${extras.join("\n\n")}`;
  }

  return systemPrompt;
}
