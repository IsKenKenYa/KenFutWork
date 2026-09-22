import type { ToolArtifact } from "@kenfutwork/shared";
import { parseTimestampMs } from "./elapsed";
import {
  completeSubagent,
  isSubagentTool,
  type SubagentEntry,
  upsertSubagentStarted,
} from "./subagent-directory";
import { parseTodos, type TodoItem } from "./todo-progress";
import { normalizeToolArgs } from "./tool-args";

/**
 * 工作台 Code 模式的 run 事件 → 任务状态纯逻辑（tool.* / message.delta）。
 *
 * 历史包袱（2026-09-20 用户反馈）：工具轨迹曾以 `task.tools` 挂在**任务**上
 * （整条任务一个数组、上限 10 条），渲染时全部堆在对话最底部——既看不出每次调用
 * 属于哪一轮对话，也看不出它发生在哪段正文之前/之后；跨轮任务还会被 10 条上限
 * 截断，只幸存最后几轮。现在工具调用按发生顺序并入**所属助手消息的有序块**
 * （`TaskMessageBlock`：文本段与工具调用交错），与两个参考产品同一形态：
 * deepseek-harness 展开 turn 后每次工具调用是独立一行、Cherry Studio 的
 * MessagePartsRenderer 逐行展示「编辑文件 xxx / 终端 … / 查阅 · N 搜 N 文件」。
 * 归属按轮切分，顺序即时间线；**不做「N 次工具调用」式聚合折叠**（用户二次反馈：
 * 聚成一团就等于看不到详细记录）。
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
  /**
   * 入参快照（tool.started 带上）：行内显示「读了哪个文件 / 跑了什么命令」。
   * 入库前经 `normalizeToolArgs` 归一化——服务端透传的节点输入实测包了一层
   * `{input:"<json>"}`，不剥掉行内提示与详情都取不到值。
   */
  input?: Record<string, unknown>;
  /** 起止时刻（毫秒，来自事件 timestamp）：轨迹视图显示每次调用的发生时间与耗时。 */
  startedAt?: number;
  endedAt?: number;
  /** 归属的 run（一次请求）：轨迹/对话据此回答「这次调用属于哪轮对话」。 */
  runId?: string;
  /** 产物（图/视频，tool.completed 带回）：详情展开时内联预览。 */
  artifacts?: ToolArtifact[];
};

/** 助手消息内的有序块：一段文本 / 一段思考 / 一次工具调用（严格按事件到达顺序交错）。 */
export type TaskMessageBlock =
  | {
      type: "text";
      text: string /** 该段正文第一个字到达的时刻（毫秒）。 */;
      at?: number;
    }
  | { type: "reasoning"; text: string; at?: number }
  | { type: "tool"; tool: TaskToolEntry };

export type TaskMessage = {
  role: "user" | "assistant";
  /**
   * 这条消息「工作了多久」（毫秒）：从这条消息的第一个字到本轮终态。
   * 用户口径：「工作时间每个 AI 对话消息都要显示，而不是只显示一部分」——
   * 所以是**每条**助手消息各自记一份，而不是只在会话头显示一个总时长。
   */
  elapsedMs?: number;
  /** 这条消息开始的时间（内部用：终态时据此算 elapsedMs）。 */
  startedAt?: number;
  /** 归属的 run（一次请求）：一轮 = 一次 run，追问换新 runId。 */
  runId?: string;
  /**
   * 全文（**只含正文，不含思考**）：追问历史拼装、右键复制、标题等纯文本消费方用；
   * 思考是推理过程不是结论，拼进「供参考」的历史只会稀释重点。流式期间与 blocks 同步维护。
   */
  text: string;
  /**
   * 有序块（文本/思考/工具交错）——**必填**：消息只有这一种形状，渲染层与
   * 投影层不做任何「无 blocks」的兜底（开发期无历史用户，schema 直接收敛）。
   * 纯文本消息就是 `[{ type: "text", text }]`，空消息是 `[]`。
   */
  blocks: TaskMessageBlock[];
};

/**
 * 单条助手消息内的工具块上限。整条任务会写进 localStorage（任务上限 100 条），
 * 单条消息不设上限时一个失控的轮次（反复调 read_file/web_search）能撑爆配额。
 * 超限丢**最旧**的块：正在收尾的最新几次调用才是用户要看的。
 */
export const MAX_TOOL_BLOCKS_PER_MESSAGE = 30;

/** 只保留最近 N 个工具块（文本块全留；被裁掉的 completed 事件自然找不到块，不会造孤儿行）。 */
export function capToolBlocks(blocks: TaskMessageBlock[]): TaskMessageBlock[] {
  let toolCount = 0;
  const kept: TaskMessageBlock[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type === "tool") {
      toolCount += 1;
      if (toolCount > MAX_TOOL_BLOCKS_PER_MESSAGE) continue;
    }
    kept.unshift(block);
  }
  return kept;
}

/** 相邻同类块并成一组（text 打断连续性）——渲染层据此把思考/工具各铺成行。 */
export type AssistantBlockGroup =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tools"; tools: TaskToolEntry[] };

export function groupAssistantBlocks(
  blocks: readonly TaskMessageBlock[],
): AssistantBlockGroup[] {
  const groups: AssistantBlockGroup[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (!block.text) continue;
      const last = groups[groups.length - 1];
      if (last?.kind === "text") {
        last.text += block.text;
      } else {
        groups.push({ kind: "text", text: block.text });
      }
      continue;
    }
    if (block.type === "reasoning") {
      const last = groups[groups.length - 1];
      if (last?.kind === "reasoning") {
        last.text += block.text;
      } else {
        groups.push({ kind: "reasoning", text: block.text });
      }
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === "tools") {
      last.tools.push(block.tool);
    } else {
      groups.push({ kind: "tools", tools: [block.tool] });
    }
  }
  return groups;
}

/**
 * 思考增量并入助手消息：末尾是思考块就续写，否则**新起一段**——
 * 与正文互相打断，位置即真实顺序。**不**并入 `message.text`：思考是推理
 * 过程不是结论，追问历史/复制的纯文本口径里不该有它（deepseek-harness 同款
 * 做法：reasoning 是独立行，不混进 assistant 正文）。
 */
export function appendThinkingDelta(
  message: TaskMessage,
  delta: string,
): TaskMessage {
  if (!delta) return message;
  const blocks = message.blocks;
  const last = blocks[blocks.length - 1];
  const nextBlocks: TaskMessageBlock[] =
    last?.type === "reasoning"
      ? [
          ...blocks.slice(0, -1),
          // 续写保持首块的 at（这一段思考的开始时刻不变）
          {
            type: "reasoning" as const,
            text: last.text + delta,
            ...(last.at !== undefined ? { at: last.at } : {}),
          },
        ]
      : [
          ...blocks,
          { type: "reasoning" as const, text: delta, at: Date.now() },
        ];
  return { ...message, blocks: nextBlocks };
}

/**
 * 文本增量并入助手消息：追加到最后一个 text 块；末尾是工具调用/思考就**新起一段**——
 * 工具之后的正文是新一轮思考的产物，不能和工具前的正文糊成一段（顺序即时间线）。
 * `text` 字段同步维护（纯文本消费方：追问历史、复制、标题）。
 */
export function appendAssistantDelta(
  message: TaskMessage,
  delta: string,
): TaskMessage {
  if (!delta) return message;
  const blocks = message.blocks;
  const last = blocks[blocks.length - 1];
  const nextBlocks: TaskMessageBlock[] =
    last?.type === "text"
      ? [
          ...blocks.slice(0, -1),
          { type: "text" as const, text: last.text + delta },
        ]
      : [...blocks, { type: "text" as const, text: delta, at: Date.now() }];
  return { ...message, text: message.text + delta, blocks: nextBlocks };
}

/**
 * 新助手消息的起点：上一条助手消息的「起点 + 耗时」链式推；推不出（老数据只有
 * 耗时没有起点）就退到本轮 run 起点，再退到此刻。
 */
export function nextAssistantStartMs(
  messages: readonly TaskMessage[],
  runStartedAt?: string,
): number {
  const previousEnd = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.elapsedMs !== undefined);
  // 只有上一条**同时有起点与耗时**时才能链式推——老数据直接相加会得到
  // 「0 + 耗时」这种荒唐的绝对时刻（实测显示成 49 万小时）。
  const previousEndMs =
    previousEnd?.startedAt !== undefined && previousEnd.elapsedMs !== undefined
      ? previousEnd.startedAt + previousEnd.elapsedMs
      : null;
  const runStart = runStartedAt ? parseTimestampMs(runStartedAt) : null;
  // 跨轮防陈旧：追问隔了很久时，「上一轮的结束」早于本轮起点——取两者较晚者，
  // 否则本轮第一条消息会带着上一轮时代的起点，「已工作」被撑大几分开外。
  if (previousEndMs !== null && runStart !== null) {
    return Math.max(previousEndMs, runStart);
  }
  return previousEndMs ?? runStart ?? Date.now();
}

/**
 * 上一条还没结算耗时的助手消息到此定稿（模型开了下一段/下一轮）。
 * 只在终态结算最后一条时，中间那些消息永远没有 elapsedMs，界面上就
 * 「只显示一部分」——用户口径是每条 AI 消息都要显示工作时间。
 */
export function settlePreviousAssistant(
  messages: readonly TaskMessage[],
  atMs: number,
): TaskMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const candidate = next[i];
    if (
      candidate?.role === "assistant" &&
      candidate.elapsedMs === undefined &&
      candidate.startedAt !== undefined
    ) {
      next[i] = {
        ...candidate,
        elapsedMs: Math.max(0, atMs - candidate.startedAt),
      };
      break;
    }
  }
  return next;
}

/**
 * 终态时给最后一条助手消息结算「已工作」时长（成功/失败/取消三个终态都调）。
 *
 * **必须整条保留原消息**（`...last` 展开）：这里曾只挑 role/text/elapsedMs/startedAt
 * 四个字段重组消息——块模型上线后，`blocks` 与 `runId` 归属在终态那一刻被整体抹掉
 * （2026-09-21 真机冒烟抓到：直播中工具块都挂得上，一跑完就全消失，要靠刷新后的
 * PG 历史回灌才找得回来）。
 */
export function settleAssistantElapsed<T extends { messages: TaskMessage[] }>(
  task: T,
): T {
  const messages = [...task.messages];
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || last.startedAt === undefined) {
    return task;
  }
  const elapsedMs = Math.max(0, Date.now() - last.startedAt);
  messages[messages.length - 1] = { ...last, elapsedMs };
  return { ...task, messages };
}

/**
 * 断线/刷新后重接 run 的本地基底：丢掉**最后一条用户消息之后**的全部内容
 * （断线前流出的半截 assistant 文本/工具块），整段交给服务端事件重放重建——
 * 与 run.retrying 的 dropPartialAssistantTail 同一思想，只是切口在用户消息上
 * （重放从 run.started 开始，会把这一轮完整重演一遍）。
 */
export function messagesBaseForResume(
  messages: readonly TaskMessage[],
): TaskMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx < 0 ? [] : messages.slice(0, lastUserIdx + 1);
}

export type ToolEventLike = {
  type: "tool.started" | "tool.completed";
  toolCallId?: string;
  toolName?: string;
  outputSummary?: string;
  output?: Record<string, unknown>;
  input?: Record<string, unknown>;
  artifacts?: ToolArtifact[];
  /** 事件所属 run：入库到工具条目与新建的助手消息上（归属哪轮对话的权威字段）。 */
  runId?: string;
  timestamp?: string;
};

/** 任务里与工具事件相关的状态（消息块 + 子代理目录 + 目标进度）；消息必给，其余可缺省。 */
export interface TaskToolState {
  messages: TaskMessage[];
  /** 本轮 run 起表时刻（ISO）：工具先于正文到达时新建助手消息要用它起表。 */
  runStartedAt?: string | undefined;
  subagents?: SubagentEntry[] | undefined;
  /** agent 自己维护的待办表（`write_todos` 整表替换语义，见 lib/todo-progress）。 */
  todos?: TodoItem[] | undefined;
}

/**
 * 工具名的中文标签（参考 Cherry Studio：「编辑文件 / 终端 / 查阅」）。
 * 原始工具名保留在 title 里——用户报 bug 时要能说出服务端认的名字。
 */
const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  edit_file: "编辑文件",
  write_file: "写入文件",
  web_search: "联网搜索",
  execute: "终端",
  task: "子任务",
  video_generate: "视频生成",
  write_todos: "更新目标",
  grep: "搜索代码",
  glob: "查找文件",
  fetch: "抓取网页",
  // Design 模式画布工具（与 chat/utils 的 TOOL_CONFIG 图标表分工：这里管中文标签）
  inspect_canvas: "读取画布",
  manipulate_canvas: "操作画布",
  screenshot_canvas: "截取画布",
  generate_image: "生成图片",
  get_brand_kit: "品牌工具包",
  project_search: "搜索项目",
};

export function toolDisplayLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

export type ToolTargetParts = {
  /** 主文案：文件名（路径类）或完整命令（终端类）。 */
  primary: string;
  /** 次文案：路径类时为所在目录（完整路径进 title）；其余为 null。 */
  rest: string | null;
  /** 终端命令（用 code 风格渲染）。 */
  isCommand: boolean;
};

/**
 * 工具行目标的三段拆分（ZCode 同款）：路径类显示「文件名 + 所在目录」（文件名
 * 是主文案、目录是次级灰），终端命令单独一档（行内 code 风格、font-sans 截断）。
 * 不在此截断——截断交给渲染层（truncate class），窄列由 CSS 隐藏次级。
 */
export function toolTargetParts(entry: TaskToolEntry): ToolTargetParts | null {
  const input = entry.input;
  if (!input) return null;
  const raw =
    (typeof input.path === "string" && input.path) ||
    (typeof input.file_path === "string" && input.file_path) ||
    "";
  if (raw) {
    const normalized = raw.replace(/\\/g, "/");
    const cut = normalized.lastIndexOf("/");
    if (cut < 0 || cut === normalized.length - 1) {
      return { primary: normalized, rest: null, isCommand: false };
    }
    return {
      primary: normalized.slice(cut + 1),
      rest: normalized.slice(0, cut),
      isCommand: false,
    };
  }
  const command =
    typeof input.command === "string" && input.command ? input.command : null;
  if (command) {
    return {
      primary: command,
      rest: null,
      isCommand: true,
    };
  }
  const text =
    (typeof input.query === "string" && input.query) ||
    (typeof input.url === "string" && input.url) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.slug === "string" && input.slug) ||
    "";
  if (!text) return null;
  return { primary: text, rest: null, isCommand: false };
}

/**
 * `tool.started`：工具块并入**最后一条助手消息**（与它前后的正文保持时序）；
 * 这条消息还没有任何助手消息（工具先于正文到达，agent 的常态）就先建一条
 * 空文本助手消息——块序上工具在正文之前，正是真实发生顺序。
 */
function startToolBlock(
  task: TaskToolState,
  entry: TaskToolEntry,
): TaskMessage[] {
  const messages = [...task.messages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    // 重复 tool.started（重连重放）：保持原状，不把已收尾的块打回执行中
    const exists = (last.blocks ?? []).some(
      (b) => b.type === "tool" && b.tool.toolCallId === entry.toolCallId,
    );
    if (exists) return messages;
    const blocks = last.blocks;
    messages[messages.length - 1] = {
      ...last,
      blocks: capToolBlocks([...blocks, { type: "tool", tool: entry }]),
    };
    return messages;
  }
  const startedAt = nextAssistantStartMs(messages, task.runStartedAt);
  return [
    ...settlePreviousAssistant(messages, startedAt),
    {
      role: "assistant",
      text: "",
      startedAt,
      ...(entry.runId ? { runId: entry.runId } : {}),
      blocks: [{ type: "tool", tool: entry }],
    },
  ];
}

/**
 * `tool.completed`：从后往前找对应 tool 块就地收尾（状态/结论/输出）。
 * 找不到（被上限裁掉/事件乱序）返回 null——不新增：宁可少一行，
 * 也不要出现「已完成」却没有「执行中」先导的孤儿行。
 */
function completeToolBlock(
  task: TaskToolState,
  toolCallId: string,
  event: ToolEventLike,
  atMs: number | null,
): TaskMessage[] | null {
  const denied = event.output?.denied === true;
  for (let i = task.messages.length - 1; i >= 0; i -= 1) {
    const message = task.messages[i];
    if (message?.role !== "assistant" || !message.blocks) continue;
    const hit = message.blocks.some(
      (b) => b.type === "tool" && b.tool.toolCallId === toolCallId,
    );
    if (!hit) continue;
    const messages = [...task.messages];
    messages[i] = {
      ...message,
      blocks: message.blocks.map((b) =>
        b.type === "tool" && b.tool.toolCallId === toolCallId
          ? {
              type: "tool",
              tool: {
                ...b.tool,
                status: denied ? ("denied" as const) : ("completed" as const),
                ...(event.outputSummary
                  ? { summary: event.outputSummary }
                  : {}),
                ...(event.output ? { output: event.output } : {}),
                // started 没带 runId 的旧事件，completed 补上归属
                ...(event.runId && !b.tool.runId ? { runId: event.runId } : {}),
                ...(event.artifacts ? { artifacts: event.artifacts } : {}),
                ...(atMs !== null ? { endedAt: atMs } : {}),
              },
            }
          : b,
      ),
    };
    return messages;
  }
  return null;
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
  event: ToolEventLike,
): T {
  const toolCallId = event.toolCallId ?? "";
  if (!toolCallId) return task;
  const toolName = event.toolName ?? "tool";
  // 目标进度：只在 write_todos 的入参可解析时覆盖（解析失败保持原状，
  // 不让一次坏参数把用户看到的进度清空）。
  const todos = toolName === "write_todos" ? parseTodos(event.input) : null;
  /** 事件时刻（毫秒）：轨迹视图按它显示每次调用的发生时间与耗时；事件没带就如实缺省。 */
  const atMs = parseTimestampMs(event.timestamp ?? "");

  const messages =
    event.type === "tool.started"
      ? startToolBlock(task, {
          toolCallId,
          toolName,
          status: "running",
          // 入库前剥掉服务端节点输入的包装层（`{input:"<json>"}`）——归一化失败
          // （不是 JSON 对象）就保留原样，宁可展示原始形状也不丢字段。
          ...(event.input
            ? { input: normalizeToolArgs(event.input) ?? event.input }
            : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...(atMs !== null ? { startedAt: atMs } : {}),
        })
      : completeToolBlock(task, toolCallId, event, atMs);

  const base: T = {
    ...task,
    ...(messages ? { messages } : {}),
    ...(todos ? { todos } : {}),
  };

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
