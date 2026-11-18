/**
 * 用户规则 → 系统提示词片段（B：设置「规则与记忆」的真实消费方）。
 *
 * 形状与 pluginPromptFragments 一致（字符串数组，一段一条），空规则返回空数组——
 * 不往提示词里塞空标题：提示词里出现「规则：」却是空的会误导模型。
 */
export const USER_RULES_HEADER = "## 用户规则（用户显式设置，必须遵守）";

export function formatUserRulesFragment(input: {
  userRules?: string | undefined;
  ruleEntries?: readonly string[] | undefined;
}): string[] {
  const text = (input.userRules ?? "").trim();
  const entries = (input.ruleEntries ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!text && entries.length === 0) return [];
  const lines: string[] = [USER_RULES_HEADER];
  if (text) lines.push(text);
  for (const entry of entries) lines.push(`- ${entry}`);
  return [lines.join("\n")];
}
