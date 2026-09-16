import { normalizeToolArgs } from "./tool-args";

/**
 * 「目标 + 进度」面板的数据来源（参考图 R1-2）。
 *
 * 数据不另开 WS 事件：agent 运行时的 `write_todos`（langchain todoListMiddleware，
 * 经 deepagents 自动装配）本身就是**整表替换**语义——每次调用都给出完整的待办列表，
 * 所以取**最后一次成功调用**的入参即可得到当前进度，无需增量归并。
 *
 * 形状（langchain todoListMiddleware 的 TodoSchema）：
 *   `{ todos: [{ content: string, status: "pending" | "in_progress" | "completed" }] }`
 *
 * 为什么单独抽成纯函数：模型给的参数是不可信输入（缺字段、status 拼错、content 空），
 * 渲染层不该自己判形状；解析与计数都要能被测试钉住。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface TodoProgress {
  /** 已完成的条数。 */
  completed: number;
  /** 全部条数。 */
  total: number;
  /** 正在进行的条数（模型通常一次只标一条，但不做假设）。 */
  inProgress: number;
}

/**
 * 从 `write_todos` 的工具入参里解析待办列表。
 *
 * 返回 `null` 表示「这次调用没有可用的待办表」（形状不对/空表）——调用方应保持原状，
 * 而不是把面板清空：一次解析失败不该让用户看到进度消失。
 */
export function parseTodos(rawInput: unknown): TodoItem[] | null {
  // 服务端透传的是包了一层的节点输入（`{input:"{\"todos\":[…]}"}`），先归一化
  const input = normalizeToolArgs(rawInput);
  if (!input) return null;
  const raw = input.todos;
  if (!Array.isArray(raw)) return null;

  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const content = (entry as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    items.push({ content: content.trim(), status: readStatus(entry) });
  }
  return items.length > 0 ? items : null;
}

/** 未知 status 归为 pending（模型偶尔会写 "done"/"blocked"，一律不当作完成）。 */
function readStatus(entry: unknown): TodoStatus {
  const status = (entry as { status?: unknown }).status;
  return status === "completed" || status === "in_progress" ? status : "pending";
}

export function todoProgress(items: TodoItem[]): TodoProgress {
  let completed = 0;
  let inProgress = 0;
  for (const item of items) {
    if (item.status === "completed") completed += 1;
    else if (item.status === "in_progress") inProgress += 1;
  }
  return { completed, total: items.length, inProgress };
}

/** 面板展示顺序：进行中 → 待办 → 已完成（完成项收在最后，便于折叠）。 */
export function sortTodosForDisplay(items: TodoItem[]): TodoItem[] {
  const rank: Record<TodoStatus, number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
  };
  return [...items].sort((a, b) => rank[a.status] - rank[b.status]);
}
