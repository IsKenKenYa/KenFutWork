import {
  completeSubagent,
  isSubagentTool,
  type SubagentEntry,
  upsertSubagentStarted,
} from "./subagent-directory";
import { parseTodos, type TodoItem } from "./todo-progress";

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
  /**
   * `denied` = 被工具门/权限档拦下（服务端合成的 tool.completed 带 `output.denied`）。
   * 与「已完成」分开：界面上写「已完成」而实际没执行，会让人以为文件/命令真的跑了
   * （实测：默认档下 write_file 被拦 3 次，工具行却全是「已完成」）。
   */
  status: "running" | "completed" | "denied";
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
  const denied = event.output?.denied === true;
  const next = tools.map((entry) => {
    if (entry.toolCallId !== toolCallId) return entry;
    matched = true;
    return {
      ...entry,
      status: denied ? ("denied" as const) : ("completed" as const),
      ...(event.outputSummary ? { summary: event.outputSummary } : {}),
      ...(event.output ? { output: event.output } : {}),
    };
  });
  return matched ? capTools(next) : tools;
}


/** 任务里与工具事件相关的状态（工具轨迹 + 子代理目录 + 目标进度）；都可缺省。 */
export interface TaskToolState {
  tools?: TaskToolEntry[];
  subagents?: SubagentEntry[];
  /** agent 自己维护的待办表（`write_todos` 整表替换语义，见 lib/todo-progress）。 */
  todos?: TodoItem[];
}

/**
 * 一条工具事件并入任务状态：**工具轨迹对所有工具都记**，子代理工具额外进目录。
 *
 * 回归背景（2026-09-15 实测）：workbench 的事件分支写成
 * `if (tool.started) { if (!isSubagentTool(name)) return; … }` ——非子代理工具在
 * 第一个分支就被 `return` 掉，永远到不了下面的通用分支（那段成了死代码），于是
 * **界面上从来没有工具调用记录**（被工具门拒绝的调用更是如此）。合并成一个函数、
 * 由测试锁住「普通工具也要进轨迹」。
 */
export function applyTaskToolEvent<T extends TaskToolState>(
  task: T,
  event: ToolEventLike & { input?: Record<string, unknown>; timestamp?: string },
): T {
  const toolCallId = event.toolCallId ?? "";
  if (!toolCallId) return task;
  const toolName = event.toolName ?? "tool";
  const tools = applyToolEvent(task.tools ?? [], event);
  // 目标进度：只在 write_todos 的入参可解析时覆盖（解析失败保持原状，
  // 不让一次坏参数把用户看到的进度清空）。
  const todos = toolName === "write_todos" ? parseTodos(event.input) : null;
  const base = { ...task, tools, ...(todos ? { todos } : {}) };

  if (event.type === "tool.started") {
    if (!isSubagentTool(toolName)) return base;
    return {
      ...base,
      subagents: upsertSubagentStarted(task.subagents ?? [], {
        toolCallId,
        toolName,
        ...(event.input ? { input: event.input } : {}),
        timestamp: event.timestamp ?? "",
      }),
    };
  }

  if (!task.subagents) return base;
  return {
    ...base,
    subagents: completeSubagent(
      task.subagents,
      toolCallId,
      event.timestamp ?? "",
    ),
  };
}
