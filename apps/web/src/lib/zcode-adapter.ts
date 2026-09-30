import type { TaskChatToolCallTreeNode } from "@/components/workbench/zcode/lib/toolCallTree.js";
import type { TaskToolEntry } from "@/lib/workbench-tools";

/**
 * DeepAgents 事件模型 → zcode ToolCallBlocks 输入形态适配层（手册 §4.3，新写非照搬）。
 *
 * 参照 references/zcode/packages/ui/src/v4/toolCallRowAdapter.ts 的 status 映射表与
 * lib/taskChatMessageTypes.ts 的 TaskChatToolCall 形状，把我方 `TaskToolEntry`
 * （apps/web/src/lib/workbench-tools.ts，DeepAgents 事件归约层，只读不改）投影为
 * `TaskChatToolCallTreeNode`。ToolCallBlock 及其 renderers（execute/read/edit/…）
 * 消费的是 zcode 旧 TaskChatToolCall 形态，本层做字段一一映射。
 *
 * status 映射（对照 zcode mapToolStatus 输入词表 pending/in_progress/completed/
 * failed/stopped）：
 * - running        → in_progress
 * - completed      → completed（summary 以「失败」开头 = 执行异常，映射 failed）
 * - denied         → stopped（被工具门/权限档拦下，未执行；zcode cancelled 同语义）
 *
 * 子代理树：我方事件流无 parentToolUseId（子代理过程走独立目录视图），恒为主层节点；
 * v2 独立子 run 落地后在 minded 处补树形投影。
 */

const STATUS_MAP: Record<TaskToolEntry["status"], string> = {
  running: "in_progress",
  completed: "completed",
  denied: "stopped",
};

/** summary 以「失败」前缀开头的完成态实为失败（workbench-tools 归约口径）。 */
function isFailedSummary(entry: TaskToolEntry): boolean {
  return entry.summary?.startsWith("失败") === true;
}

function statusOf(entry: TaskToolEntry): string {
  if (entry.status === "completed" && isFailedSummary(entry)) return "failed";
  return STATUS_MAP[entry.status];
}

/** 标题：zcode renderer 的 title 兜底链（kind → kindLabel）消费它；给「工具名 · 摘要」。 */
function titleOf(entry: TaskToolEntry): string | undefined {
  if (!entry.summary) return undefined;
  const head = entry.summary.split("\n")[0] ?? entry.summary;
  return head.length > 120 ? `${head.slice(0, 119)}…` : head;
}

/** 失败态错误文本：renderer 的 statusTooltip 消费它。 */
function errorOf(entry: TaskToolEntry): string | undefined {
  return isFailedSummary(entry) || entry.status === "denied"
    ? (entry.summary ?? undefined)
    : undefined;
}

/** 把一条 DeepAgents 工具事件投影为 zcode 树节点（恒为主层节点，见文件头说明）。 */
export function toToolCallTreeNode(
  entry: TaskToolEntry,
): TaskChatToolCallTreeNode {
  return {
    toolCall: {
      toolId: entry.toolCallId,
      // 我方无 parent 归属：主层节点恒 null（zcode null = 主 agent 直发）
      parentToolUseId: null,
      toolName: entry.toolName,
      // kind 是 zcode 聚合分类的兜底键；我方无 kind 概念，给工具名本身
      kind: entry.toolName,
      ...(entry.summary ? { title: titleOf(entry) } : {}),
      input: entry.input,
      status: statusOf(entry),
      output: entry.output,
      ...(errorOf(entry) ? { error: errorOf(entry) } : {}),
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
    },
    childToolCalls: [],
  };
}

/** 批量投影（保序）。 */
export function toToolCallTreeNodes(
  entries: readonly TaskToolEntry[],
): TaskChatToolCallTreeNode[] {
  return entries.map(toToolCallTreeNode);
}
