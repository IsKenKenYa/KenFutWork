import { normalizeToolArgs } from "./tool-args";

/**
 * 子代理目录（R1-3）的纯逻辑：从工具事件流推导子代理运行条目。
 *
 * 服务端把子代理作为父工具暴露（deepagents 内置 `task`、本仓库的 `video_generate`），
 * 前端从 `tool.started` / `tool.completed` 推导「正在运行 / 已结束」列表——
 * 不需要新增 WS 事件类型。纯函数便于单测。
 */

export const SUBAGENT_TOOL_NAMES = new Set([
  "task",
  "task_background",
  "video_generate",
]);

export interface SubagentEntry {
  toolCallId: string;
  /** 子代理名：优先取输入里的显式名称，缺省用工具名。 */
  name: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
}

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}

/** tool.started：新条目插到最前；同一 toolCallId 重复开始视为重启（更新起始时刻）。 */
export function upsertSubagentStarted(
  list: SubagentEntry[],
  event: {
    toolCallId: string;
    toolName: string;
    input?: Record<string, unknown>;
    timestamp: string;
    agentName?: string;
  },
): SubagentEntry[] {
  // 入参同样要归一化：服务端透传的是包了一层的节点输入（见 lib/tool-args）
  const args = normalizeToolArgs(event.input) ?? {};
  const inputName = args.name ?? args.subagent_type;
  const description =
    typeof args.description === "string" ? args.description : undefined;
  const name =
    typeof inputName === "string" && inputName.length > 0
      ? inputName
      : event.agentName ?? event.toolName;
  const existing = list.find((entry) => entry.toolCallId === event.toolCallId);
  const entry: SubagentEntry = {
    toolCallId: event.toolCallId,
    name,
    ...(description ? { description } : {}),
    startedAt: event.timestamp,
  };
  if (existing) {
    return list.map((item) => (item === existing ? entry : item));
  }
  return [entry, ...list];
}

/** tool.completed：匹配 toolCallId 的条目落终态时刻。 */
export function completeSubagent(
  list: SubagentEntry[],
  toolCallId: string,
  endedAt: string,
): SubagentEntry[] {
  return list.map((entry) =>
    entry.toolCallId === toolCallId && !entry.endedAt
      ? { ...entry, endedAt }
      : entry,
  );
}

/** 一轮结束（成功/失败/取消）时兜底关掉还没收到 completed 的条目。 */
export function closeAllSubagents(
  list: SubagentEntry[],
  endedAt: string,
): SubagentEntry[] {
  return list.map((entry) => (entry.endedAt ? entry : { ...entry, endedAt }));
}

/** 汇总：运行中 / 已结束计数。 */
export function summarizeSubagents(list: SubagentEntry[]): {
  running: number;
  finished: number;
} {
  const running = list.filter((entry) => !entry.endedAt).length;
  return { running, finished: list.length - running };
}
