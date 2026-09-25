import type { CheckpointSummary } from "@kenfutwork/shared";

/**
 * Code 模式检查点条的展示规则（纯逻辑，单测护航）。
 *
 * 每轮 run 服务端会落「轮次开始快照」与「轮次结束快照」两行（run 开始时目录为空、
 * 或结束时没有改动就不落行）。chip 只认该 run 下 createdAt 最新的那行——结束快照
 * 因此天然压过开始快照；只有开始快照的轮（失败/无改动收尾）也能挑出可回滚的行。
 */

/**
 * 取该 runId 下 createdAt 最新的检查点；没有匹配行（含空列表）返回 null。
 * createdAt 相同时取列表靠后的行（服务端按 createdAt 升序返回，靠后即更晚落行）。
 */
export function pickCheckpointForRun(
  rows: CheckpointSummary[],
  runId: string,
): CheckpointSummary | null {
  let picked: CheckpointSummary | null = null;
  for (const row of rows) {
    if (row.runId !== runId) continue;
    if (picked === null || tsOf(row.createdAt) >= tsOf(picked.createdAt)) {
      picked = row;
    }
  }
  return picked;
}

/** ISO 时间戳 → 毫秒；解析失败按 0（不抛错，排序退化为「列表里最后一行 wins」）。 */
function tsOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** chip 的统计文案：`3 个文件 +12 −4`（服务端汇总口径，二进制文件不计行数）。 */
export function formatCheckpointStats(checkpoint: CheckpointSummary): string {
  return `${checkpoint.filesChanged} 个文件 +${checkpoint.insertions} −${checkpoint.deletions}`;
}

/** 检查点类型的中文短标（回滚目标下拉与 chip 共用一套口径）。 */
export function checkpointKindLabel(kind: CheckpointSummary["kind"]): string {
  if (kind === "baseline") return "基线快照";
  if (kind === "restore") return "回滚恢复点";
  return "轮次快照";
}

/**
 * 回滚目标的候选列表：最新在前。服务端按 createdAt 升序返回，反转即倒序；
 * createdAt 相同时反转后「原列表靠后的行」排前面——与 pickCheckpointForRun
 * 的「靠后即更晚落行」同一口径。
 */
export function toCheckpointOptions(
  rows: CheckpointSummary[],
): CheckpointSummary[] {
  return [...rows].reverse();
}

/** 回滚目标下拉的选项文案：`轮次快照 · 10:05 · 3 个文件 +12 −4`。 */
export function formatCheckpointOption(checkpoint: CheckpointSummary): string {
  const date = new Date(checkpoint.createdAt);
  const time = Number.isNaN(date.getTime())
    ? ""
    : ` · ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${checkpointKindLabel(checkpoint.kind)}${time} · ${formatCheckpointStats(checkpoint)}`;
}
