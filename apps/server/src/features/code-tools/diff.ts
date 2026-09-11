/**
 * 行级 diff（LCS）：v1 自建实现，避免新增依赖（§4.11 选型待定时先内聚最小实现）。
 * 输出 unified 风格的行片段：context/added/removed。
 */

export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const rows = a.length;
  const cols = b.length;
  // LCS 长度表
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }
  // 回溯出差异序列
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      result.push({ type: "context", text: a[i]! });
      i++;
      j++;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      result.push({ type: "removed", text: a[i]! });
      i++;
    } else {
      result.push({ type: "added", text: b[j]! });
      j++;
    }
  }
  while (i < rows) {
    result.push({ type: "removed", text: a[i]! });
    i++;
  }
  while (j < cols) {
    result.push({ type: "added", text: b[j]! });
    j++;
  }
  return result;
}

/** 紧凑统计：+N -M */
export function summarizeDiff(lines: DiffLine[]): string {
  const added = lines.filter((l) => l.type === "added").length;
  const removed = lines.filter((l) => l.type === "removed").length;
  return `+${added} -${removed}`;
}
