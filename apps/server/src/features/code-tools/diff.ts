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
    const row = lcs[i];
    if (!row) continue;
    for (let j = cols - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  // 回溯出差异序列
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    const beforeLine = a[i] ?? "";
    const afterLine = b[j] ?? "";
    if (beforeLine === afterLine) {
      result.push({ type: "context", text: beforeLine });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      result.push({ type: "removed", text: beforeLine });
      i++;
    } else {
      result.push({ type: "added", text: afterLine });
      j++;
    }
  }
  for (const line of a.slice(i)) {
    result.push({ type: "removed", text: line });
  }
  for (const line of b.slice(j)) {
    result.push({ type: "added", text: line });
  }
  return result;
}

/** 紧凑统计：+N -M */
export function summarizeDiff(lines: DiffLine[]): string {
  const added = lines.filter((l) => l.type === "added").length;
  const removed = lines.filter((l) => l.type === "removed").length;
  return `+${added} -${removed}`;
}
