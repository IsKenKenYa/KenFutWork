import type {
  RunTimelineEntry,
  RunTimelineEntryKind,
  RunTimelineResult,
} from "./types.js";

/** 条目类别 → 导出里的文字前缀。 */
const KIND_PREFIX: Record<RunTimelineEntryKind, string> = {
  run: "运行",
  tool: "工具",
  subagent: "子代理",
  command: "命令",
  compaction: "压缩",
  hook: "钩子",
  retry: "重试",
};

const STATUS_LABELS = {
  success: "成功",
  error: "失败",
  cancelled: "已停止",
  running: "进行中",
} as const;

/** 把单轮时间线渲染成 Markdown，供下载归档与排查。 */
export function renderRunTimelineMarkdown(timeline: RunTimelineResult): string {
  const run = timeline.run;
  const lines: string[] = [
    `# 运行时间线 · ${escapeInline(run.runId)}`,
    "",
    `- 状态：${escapeInline(run.status)}`,
    `- 模型：${run.model ? escapeInline(run.model) : "未记录"}`,
    `- 开始：${escapeInline(run.startedAt)}`,
    `- 完成：${run.completedAt ? escapeInline(run.completedAt) : "仍在运行或未收尾"}`,
    `- 时长：${describeDuration(run.startedAt, run.completedAt)}`,
    `- 用量：${describeUsage(run.usage)}`,
  ];
  if (run.stopReason)
    lines.push(`- 停止原因：${escapeInline(run.stopReason)}`);
  if (run.errorCode)
    lines.push(`- 失败代码：${escapeInline(run.errorCode)}`);
  if (run.errorMessage)
    lines.push(`- 失败原因：${escapeInline(run.errorMessage)}`);
  lines.push(
    `- 条目：${timeline.entries.length} 条`,
    "",
    "## 时间线",
    "",
  );

  if (!timeline.entries.length) {
    lines.push("这一轮没有留下可回看的事件。");
  } else {
    for (const entry of timeline.entries) lines.push(describeEntry(entry));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** 导出文件名：只保留安全字符，避免 Content-Disposition 注入。 */
export function runTimelineFilename(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `run-${safe || "unknown"}-timeline.md`;
}

function describeEntry(entry: RunTimelineEntry): string {
  const parts = [
    `- ${escapeInline(entry.at)}`,
    `**[${KIND_PREFIX[entry.kind]}]**`,
    escapeInline(entry.title),
  ];
  if (entry.agentName)
    parts.push(`（子代理：${escapeInline(entry.agentName)}）`);
  if (entry.status) parts.push(`· ${STATUS_LABELS[entry.status]}`);
  if (entry.durationMs !== undefined)
    parts.push(`· ${formatDuration(entry.durationMs)}`);
  if (entry.detail) parts.push(`· ${escapeInline(entry.detail)}`);
  return parts.join(" ");
}

function describeUsage(
  usage: RunTimelineResult["run"]["usage"],
): string {
  if (!usage) return "未统计";
  const cost =
    usage.costUsd === null ? "成本未上报" : `成本 $${usage.costUsd.toFixed(6)}`;
  return `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · ${cost}`;
}

function describeDuration(
  startedAt: string,
  completedAt: string | null,
): string {
  if (!completedAt) return "—";
  const started = Date.parse(startedAt);
  const finished = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished))
    return "—";
  return formatDuration(Math.max(0, finished - started));
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}

/**
 * Markdown 行内转义：换行压成空格，避免一个条目拆成多行破坏列表；
 * 方括号、反引号与竖线转义，防止被当成链接、代码或表格分隔。
 */
function escapeInline(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
