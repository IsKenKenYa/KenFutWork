/**
 * 审查视图「暂存块」用的 diff 切分（参考图：diff 里每个块左侧一个浮出的「暂存块」）。
 *
 * 一个统一 diff 的结构是「文件头 + 若干块」，每块以 `@@ -a,b +c,d @@` 开头。
 * 要把某一块单独交给 `git apply --cached`，就必须把**文件头**（`diff --git` / `index` /
 * `---` / `+++`）与**这一块**拼回去——只发块本身，git 会说「缺少文件名信息」（实测）。
 * 切分放在这里、纯函数，UI 只按行渲染。
 */

export interface DiffHunk {
  /** 块头（`@@ … @@` 那一行，可能带函数名）。 */
  header: string;
  /** 这一块的完整内容（含块头，含行尾换行）。 */
  body: string;
  /** 第几块（从 0 起，做 key 用）。 */
  index: number;
}

export interface SplitDiff {
  /** 文件头（从 `diff --git` 到第一个 `@@` 之前），可能为空（例如合成视图）。 */
  fileHeader: string;
  hunks: DiffHunk[];
}

/** 把统一 diff 切成「文件头 + 块」。没有块（如未跟踪文件的合成视图）时 hunks 为空。 */
export function splitHunks(diffText: string): SplitDiff {
  const lines = diffText.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) {
    return { fileHeader: diffText, hunks: [] };
  }
  const fileHeader = lines.slice(0, firstHunk).join("\n");
  const hunks: DiffHunk[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    hunks.push({
      header: current[0] ?? "",
      body: current.join("\n"),
      index: hunks.length,
    });
    current = [];
  };
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@") && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return { fileHeader, hunks };
}

/**
 * 拼出「只含这一块」的 patch（文件头 + 块）。末尾补一个换行——
 * patch 的最后一行没有换行符时 git 会认为文件被截断（`\ No newline` 语义）。
 */
export function hunkPatch(fileHeader: string, hunk: DiffHunk): string {
  const header =
    fileHeader.endsWith("\n") || fileHeader === ""
      ? fileHeader
      : `${fileHeader}\n`;
  return `${header}${hunk.body.endsWith("\n") ? hunk.body : `${hunk.body}\n`}`;
}

/**
 * diff 文本 → 逐行渲染用的行（带类型，供 UI 上色），并标出每个块的第一行。
 * `hunkIndex` 只在该块的第一行上有值。
 */
export interface DiffLine {
  text: string;
  kind: "meta" | "hunk" | "add" | "del" | "context";
  hunkIndex?: number;
}

export function toDiffLines(diffText: string): DiffLine[] {
  return diffText.split("\n").map((line) => {
    if (line.startsWith("@@")) return { text: line, kind: "hunk" as const };
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity") ||
      line.startsWith("rename ")
    ) {
      return { text: line, kind: "meta" as const };
    }
    if (line.startsWith("+")) return { text: line, kind: "add" as const };
    if (line.startsWith("-")) return { text: line, kind: "del" as const };
    return { text: line, kind: "context" as const };
  });
}

/** 把 `toDiffLines` 的结果标上块号（每块第一行带 hunkIndex）。 */
export function markHunkStarts(lines: DiffLine[]): DiffLine[] {
  let index = -1;
  return lines.map((line) => {
    if (line.kind !== "hunk") return line;
    index += 1;
    return { ...line, hunkIndex: index };
  });
}
