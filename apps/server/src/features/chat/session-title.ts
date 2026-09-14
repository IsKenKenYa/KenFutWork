/**
 * 会话标题派生（Code 模式懒供给用）。
 *
 * 客户端发给 run 的 prompt 会拼进面向模型的指令前缀块（工作目录提示
 * 【目录名称：…】、思考强度【思考强度：…】）。历史上标题直接取 prompt 前 24 字，
 * 于是侧栏/会话列表出现「【目录名称：test（仅用户标注的命名提示；本机路径…」
 * 这样的内部指令泄漏。派生先剥掉**行首连续的【…】指令块**再切片，用户正文
 * （哪怕以【开头的中段内容）不受影响——只剥首部整行成块的标记。
 */

/** 会话标题缺省值（正文为空时）。 */
export const DEFAULT_SESSION_TITLE = "新任务";

/** 剥掉 prompt 首部连续的整行【…】指令块。 */
export function stripLeadingDirectiveBlocks(prompt: string): string {
  const lines = prompt.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("【") && line.endsWith("】")) {
      index += 1;
      continue;
    }
    // 指令块与正文之间允许空行
    if (line === "") {
      // 末尾全是空行时不继续剥（交由 trim 处理）
      if (lines.slice(index).every((l) => l.trim() === "")) break;
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join("\n").trim();
}

/** 从 run prompt 派生会话标题：剥指令块 → 取前 24 字 → 空则缺省。 */
export function deriveSessionTitle(prompt: string): string {
  const body = stripLeadingDirectiveBlocks(prompt).slice(0, 24).trim();
  return body || DEFAULT_SESSION_TITLE;
}
