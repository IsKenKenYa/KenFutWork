import { normalizeToolArgs } from "./tool-args";

/**
 * 子代理目录（R1-3）的纯逻辑：从工具事件流推导子代理运行条目。
 *
 * 服务端把子代理作为父工具暴露（deepagents 内置 `task`、本仓库的 `video_generate`），
 * 前端从 `tool.started` / `tool.completed` 推导「正在运行 / 已结束」列表——
 * 不需要新增 WS 事件类型。纯函数便于单测。
 */

export const SUBAGENT_TOOL_NAMES = new Set([
  "subagent_task",
  "subagent_background",
  "video_generate",
]);

export interface SubagentEntry {
  toolCallId: string;
  /** 子代理名：优先取输入里的显式名称，缺省用工具名。 */
  name: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  /** 该子代理自己的转录（声明在后，见文件尾「子代理视图路由」）。 */
  blocks: SubagentBlock[];
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
      : (event.agentName ?? event.toolName);
  const existing = list.find((entry) => entry.toolCallId === event.toolCallId);
  const entry: SubagentEntry = {
    toolCallId: event.toolCallId,
    name,
    ...(description ? { description } : {}),
    startedAt: event.timestamp,
    blocks: existing?.blocks ?? [],
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

// ── 子代理视图路由（zcode 右栏模型）─────────────────────────────
//
// 子代理内部的正文/思考/工具事件带 `agentCallId`（父 run 里派发调用的
// toolCallId），**不进主对话流**——按它路由进对应条目的独立转录，
// 右栏「子智能体」页签点开即看（zcode 同款交互）。

/** 子代理工具行（独立转录内；结构最小化，避免与主转录类型循环依赖）。 */
export type SubagentToolRow = {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed";
  input?: Record<string, unknown> | undefined;
  outputSummary?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
};

export type SubagentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; tool: SubagentToolRow };

export interface SubagentEntry {
  toolCallId: string;
  /** 子代理名：优先取输入里的显式名称，缺省用工具名。 */
  name: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  /** 该子代理自己的转录（正文/思考/工具，按到达顺序）——不进主对话。 */
  blocks: SubagentBlock[];
}

/**
 * 单个子代理转录的块数上限：后台子代理一轮可执行上百次工具调用，
 * 不设上限会把整条任务撑爆 localStorage（对齐主消息 MAX_TOOL_BLOCKS 思路，
 * 丢最旧的保留最新过程）。
 */
export const MAX_BLOCKS_PER_SUBAGENT = 120;

function capBlocks(blocks: SubagentBlock[]): SubagentBlock[] {
  return blocks.length <= MAX_BLOCKS_PER_SUBAGENT
    ? blocks
    : blocks.slice(blocks.length - MAX_BLOCKS_PER_SUBAGENT);
}

/** 解析事件时刻为毫秒（脏数据如实缺省）。 */
function parseMs(timestamp?: string): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 子代理内部工具事件落进对应条目的转录。toolCallId 是子代理内部的调用 id，
 * 与主对话的 id 空间互不影响；started/completed 靠它配对。
 */
export function appendSubagentTool(
  list: SubagentEntry[],
  event: {
    agentCallId: string;
    toolCallId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    outputSummary?: string;
    timestamp?: string;
    type: "tool.started" | "tool.completed";
  },
): SubagentEntry[] {
  const toolCallId = event.toolCallId;
  if (!toolCallId) return list;
  return list.map((entry) => {
    if (entry.toolCallId !== event.agentCallId) return entry;
    const blocks = [...entry.blocks];
    const idx = blocks.findIndex(
      (block) => block.type === "tool" && block.tool.toolCallId === toolCallId,
    );
    if (event.type === "tool.started") {
      if (idx >= 0) return entry;
      blocks.push({
        type: "tool",
        tool: {
          toolCallId,
          toolName: event.toolName ?? "tool",
          status: "running",
          ...(event.input ? { input: event.input } : {}),
          startedAt: parseMs(event.timestamp),
        },
      });
    } else {
      const hit = blocks[idx];
      if (hit?.type !== "tool") return entry;
      blocks[idx] = {
        type: "tool",
        tool: {
          ...hit.tool,
          status: "completed",
          ...(event.outputSummary
            ? { outputSummary: event.outputSummary }
            : {}),
          endedAt: parseMs(event.timestamp),
        },
      };
    }
    return { ...entry, blocks };
  });
}

/** 子代理内部正文/思考增量：并入该条目转录（末块同类续写，否则新起一块）。 */
export function appendSubagentDelta(
  list: SubagentEntry[],
  agentCallId: string,
  kind: "text" | "thinking",
  delta: string,
): SubagentEntry[] {
  if (!delta) return list;
  return list.map((entry) => {
    if (entry.toolCallId !== agentCallId) return entry;
    const blocks = [...entry.blocks];
    const last = blocks[blocks.length - 1];
    if (last?.type === kind) {
      blocks[blocks.length - 1] = { type: kind, text: last.text + delta };
    } else {
      blocks.push({ type: kind, text: delta });
    }
    return { ...entry, blocks: capBlocks(blocks) };
  });
}

/** 后台子代理结算（task.notification 带 agentCallId）：落终态时刻。 */
export function completeSubagentByCallId(
  list: SubagentEntry[],
  agentCallId: string,
  endedAt: string,
): SubagentEntry[] {
  return list.map((entry) =>
    entry.toolCallId === agentCallId && !entry.endedAt
      ? { ...entry, endedAt }
      : entry,
  );
}

/**
 * 隐式子代理条目（兜底路由）：凡带 agentName 的事件都归属一个以调用键
 * （agentCallId 或 `agent:<名字>`）为 identity 的条目——无论子代理由哪条
 * 机制派生（我们的 subagent_task、deepagents 内建 task），消息都不进主对话。
 */
export function upsertImplicitSubagent(
  list: SubagentEntry[],
  event: { callKey: string; name: string; timestamp?: string | undefined },
): SubagentEntry[] {
  const existing = list.find((entry) => entry.toolCallId === event.callKey);
  if (existing) return list;
  const entry: SubagentEntry = {
    toolCallId: event.callKey,
    name: event.name,
    startedAt: event.timestamp ?? new Date().toISOString(),
    blocks: [],
  };
  return [entry, ...list];
}
