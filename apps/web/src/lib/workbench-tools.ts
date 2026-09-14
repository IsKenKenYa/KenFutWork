/**
 * 工作台的工具调用轨迹（`tool.started` / `tool.completed` 事件 → 任务状态）。
 *
 * 为什么单独抽出来：工作台此前**完全忽略** tool.* 事件——用户只看得到模型的话术，
 * 看不到工具跑了什么；联网搜索的来源列表因此从未在 Code 模式出现过（产品早写好的
 * `ToolOutputRenderer` 只管着已退役的旧对话 UI）。判定逻辑抽成纯函数，便于把
 * 「按 toolCallId 归并、失败也收尾、无上限会撑爆 localStorage」这几条边界测住。
 */

export type TaskToolEntry = {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed";
  /** 完成时的一句话结论（失败时形如「失败：…」）。 */
  summary?: string;
  /** 结构化输出：交回既有渲染器（web_search 会渲染成可点击来源）。 */
  output?: Record<string, unknown>;
};

/** 整条任务会写进 localStorage，工具轨迹必须有上限，否则撑爆配额。 */
export const MAX_TASK_TOOLS = 10;

/** 只保留最近 N 条（新的在后面）。 */
export function capTools(entries: TaskToolEntry[]): TaskToolEntry[] {
  return entries.length > MAX_TASK_TOOLS
    ? entries.slice(entries.length - MAX_TASK_TOOLS)
    : entries;
}

export type ToolEventLike = {
  type: "tool.started" | "tool.completed";
  toolCallId?: string;
  toolName?: string;
  outputSummary?: string;
  output?: Record<string, unknown>;
};

/**
 * 把一条工具事件并入轨迹。
 *
 * 边界：没有 toolCallId 的事件直接丢弃（归并键就是它，缺了只会造出无法配对的幽灵行）；
 * `tool.completed` 找不到对应行时**不新增**（宁可少一行，也不要出现「已完成」却没有
 * 「执行中」先导的孤儿行）。
 */
export function applyToolEvent(
  tools: TaskToolEntry[],
  event: ToolEventLike,
): TaskToolEntry[] {
  const toolCallId = event.toolCallId ?? "";
  if (!toolCallId) return tools;

  if (event.type === "tool.started") {
    const toolName = event.toolName ?? "tool";
    return capTools([...tools, { toolCallId, toolName, status: "running" }]);
  }

  let matched = false;
  const next = tools.map((entry) => {
    if (entry.toolCallId !== toolCallId) return entry;
    matched = true;
    return {
      ...entry,
      status: "completed" as const,
      ...(event.outputSummary ? { summary: event.outputSummary } : {}),
      ...(event.output ? { output: event.output } : {}),
    };
  });
  return matched ? capTools(next) : tools;
}
