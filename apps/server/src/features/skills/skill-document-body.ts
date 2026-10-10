// ZCode 3.14.3 / 29628c9acdb81b703bbd4080c207a0e7ce5e276e, Apache-2.0.
// 提取原readFrontmatter的正文分支与纯函数依赖；只改变返回边界，原算法保留。
export function readSkillDocumentBody(content: string): string {
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) return normalized.trim();

  const frontmatterText = frontmatterMatch[1] ?? "";
  const frontmatterParts = splitFrontmatterAndLeakedBody(frontmatterText);
  const bodyAfterFrontmatter = normalized.slice(frontmatterMatch[0].length).trim();
  const body = [frontmatterParts.leakedBody, bodyAfterFrontmatter]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  return body;
}

function splitFrontmatterAndLeakedBody(frontmatterText: string): {
  metadataText: string;
  leakedBody: string;
} {
  const lines = frontmatterText.split("\n");
  const leakedBodyStartIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      // 部分历史 skill 把正文标题写在 closing --- 之前。
      // 遇到 Markdown 标题时，将这一段从 frontmatter 挪回 body，避免说明内容被解析阶段吞掉。
      /^#{1,6}\s+\S/.test(line),
  );
  if (leakedBodyStartIndex < 0) {
    return { metadataText: frontmatterText, leakedBody: "" };
  }
  return {
    metadataText: lines.slice(0, leakedBodyStartIndex).join("\n").trimEnd(),
    leakedBody: lines.slice(leakedBodyStartIndex).join("\n").trim(),
  };
}
