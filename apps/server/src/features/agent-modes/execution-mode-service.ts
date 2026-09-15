import type { ExecutionMode } from "@loomic/shared";

import type {
  ExecutionModeScope,
  ExecutionModeStore,
} from "./execution-mode-store.js";

/**
 * agentModes 缝（DEC-3，P6）：只管激活/切换/持久化当前模式。
 * 指令引导（inputDirective）+ 工具硬约束（resolveToolPolicy）双层：
 * plan/solo 在引导之外还有 tool-pre-execute 级别的强制拦截（§4.6「引导不是强制」
 * 仅适用于 goal/loop/creative 等无法机械判定的模式）。
 *
 * 持久化是**写穿缓存**：Map 是本进程热缓存，activate 带 scope 时写回
 * chat_sessions.execution_mode；未声明模式的 run 起跑前 hydrate 读回。
 * 无 store（部分装配/单测）时退化为纯内存——与旧版行为一致。
 */

export const BUILTIN_EXECUTION_MODES: Array<{
  id: ExecutionMode;
  label: string;
  description: string;
  /** pre-step 注入的输入前缀（各模式逻辑独立，不做大一统 mode 引擎）。 */
  inputDirective?: string;
}> = [
  {
    id: "agent",
    label: "自主",
    description: "默认：agent 自主循环完成任务。",
  },
  {
    id: "plan",
    label: "计划",
    description: "先产出分步计划待用户批准，再逐步执行；批准前只读。",
    inputDirective:
      '<execution_mode name="plan">\n请先给出分步执行计划并等待用户批准，再开始实际修改；未获批准前不要执行不可逆操作（修改/命令执行/外部调用会被系统拦截）。\n</execution_mode>',
  },
  {
    id: "solo",
    label: "对话",
    description: "纯对话交流，不执行工具与文件修改（工具调用会被系统拦截）。",
    inputDirective:
      '<execution_mode name="solo">\n本轮为纯对话模式：只进行文字交流，不调用任何工具、不修改任何文件（工具调用会被系统直接拒绝）。\n</execution_mode>',
  },
  {
    id: "goal",
    label: "目标",
    description: "目标驱动：先明确成功标准，循环推进直至达成。",
    inputDirective:
      '<execution_mode name="goal">\n本轮为目标驱动模式：先与用户明确成功标准（可验证），再围绕目标循环推进，每步说明进度与剩余差距。\n</execution_mode>',
  },
  {
    id: "loop",
    label: "循环",
    description: "循环执行：按固定步骤反复迭代直到完成。",
    inputDirective:
      '<execution_mode name="loop">\n本轮为循环模式：按固定步骤反复迭代（执行→检查→修正），直到任务完成或达到用户设定的停止条件。\n</execution_mode>',
  },
  {
    id: "creative",
    label: "创造",
    description: "插件/技能创造引导：按规范产出 SKILL.md 或插件 bundle 产物。",
    inputDirective:
      '<execution_mode name="creative">\n本轮为创造模式，目标是产出**可安装**的插件/技能产物：\n1. 先与用户确认交付物形态（SKILL.md 技能 / 插件 bundle 目录）；\n2. 技能以 SKILL.md 开头（YAML frontmatter 含 name/description，正文为操作指引，附属文件与 SKILL.md 同目录）；\n3. 技能写好后**调用 create_skill 工具发布到当前工作区**（name/description/content 必填，content 即 SKILL.md 全文），发布即启用、后续会话可用——不要只把文件留在工作目录里让用户手动导入；\n4. 插件 bundle 无法直接安装时，告知文件位置并指引用户通过插件市场导入；\n5. 不要擅自删除或覆盖既有产物，生成前先检查目录现状。\n</execution_mode>',
  },
];

/**
 * plan 模式放行的只读工具白名单（含 deepagents 内置文件工具与内核只读工具）。
 * 白名单外一律拒绝：修改类文件工具、execute、子代理 task、MCP/生成/画布写操作。
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // deepagents FilesystemMiddleware 内置只读工具
  "ls",
  "read_file",
  "glob",
  "grep",
  "write_todos",
  // 内核注册的只读工具
  "web_search",
  "list_skills",
  "use_skill",
  "project_search",
  "inspect_canvas",
  "screenshot_canvas",
  "get_brand_kit",
]);

/**
 * plan 批准短语的**保守白名单**（机器可读批准门）。
 *
 * 背景：plan 档产出计划后模型会等用户批准，但文字「批准」过去不解锁工具门，
 * 用户必须再手动把执行模式切回自主（GUI 实测多绕一步）。现在 run 入口检测到
 * 「线程处于 plan + 消息本身就是批准短语」时，本条消息起按 agent 执行。
 *
 * 刻意用**整句精确匹配**而非子串：含批准词但带额外内容的消息
 * （「批准这个方案，不过第三步先改改」「不批准」）一律不算——
 * 误升档比多切一次档危险。
 */
const PLAN_APPROVAL_PHRASES: ReadonlySet<string> = new Set([
  "批准",
  "批准了",
  "批准执行",
  "同意",
  "同意执行",
  "通过",
  "开始执行",
  "开始吧",
  "执行吧",
  "继续执行",
  "按计划执行",
  "照计划执行",
  "就这么办",
  "没问题",
  "可以",
  "行",
  "好",
  "好的",
  "ok",
  "okay",
  "go",
  "go ahead",
  "approved",
  "approve",
  "lgtm",
]);

/** 判定单行文本是否为 plan 批准短语（整句、忽略首尾空白与句末标点、拉丁不区分大小写）。 */
export function isPlanApprovalMessage(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 12) {
    return false;
  }
  const normalized = trimmed
    .replace(/[.!?:;、。！？：；，,\s]+$/u, "")
    .trim()
    .toLowerCase();
  return PLAN_APPROVAL_PHRASES.has(normalized);
}

/**
 * 判定一条 run 输入（可能是 workbench 组合的带历史块 prompt）是否为批准。
 *
 * workbench 的追问把对话历史拼进 prompt：`【对话历史…】【本轮用户消息】\n<原文>`，
 * 对整块匹配会因长度超限永远不命中（GUI 实测踩中）。marker 存在时**本轮用户消息
 * 一定是最后一行**；无 marker 的首条消息取末行同样保守（多行消息以「批准」结尾
 * 视为批准，语义成立）。
 */
export function isPlanApprovalInput(prompt: string): boolean {
  const lines = prompt.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? "";
  return isPlanApprovalMessage(lastLine);
}

/** 模式工具策略：solo 全禁、plan 只读，其余全放行。 */
export type ToolPolicy =
  | { kind: "allow-all" }
  | { kind: "deny-all"; reason: string }
  | { kind: "read-only"; reason: string };

const SOLO_DENY_REASON = "solo 对话模式：纯对话交流，工具调用已禁用。";
const PLAN_DENY_REASON =
  "plan 计划模式：计划批准前仅允许只读工具，修改/执行/外部调用被拒绝。";

/** 按策略判定单个工具（纯函数，内核事件缝与 deep-agent 门中间件共用）。 */
export function evaluateToolPolicy(
  policy: ToolPolicy,
  toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (policy.kind === "allow-all") {
    return { allowed: true };
  }
  if (policy.kind === "deny-all") {
    return { allowed: false, reason: policy.reason };
  }
  return READ_ONLY_TOOLS.has(toolName)
    ? { allowed: true }
    : { allowed: false, reason: policy.reason };
}

function policyForMode(mode: ExecutionMode): ToolPolicy {
  switch (mode) {
    case "solo":
      return { kind: "deny-all", reason: SOLO_DENY_REASON };
    case "plan":
      return { kind: "read-only", reason: PLAN_DENY_REASON };
    default:
      return { kind: "allow-all" };
  }
}

export interface ExecutionModeService {
  listModes(): Array<{
    id: ExecutionMode;
    label: string;
    description: string;
    inputDirective?: string;
  }>;
  /** 当前线程激活的模式（进程内缓存）；未激活返回默认 agent。 */
  getMode(threadId: string): ExecutionMode;
  /** 激活/切换当前线程模式；未知模式 fail loud。带 scope 时写回库（重启后仍生效）。 */
  activate(
    threadId: string,
    mode: ExecutionMode,
    scope?: ExecutionModeScope,
  ): Promise<void>;
  /** 读回线程持久化模式并 warm 缓存；无行/未设置/无 store 时回落 agent。 */
  hydrate(threadId: string, scope: ExecutionModeScope): Promise<ExecutionMode>;
  /** 归属校验 + 读回（HTTP 读端点与 PUT 的越权校验用）。 */
  lookup(
    threadId: string,
    scope: ExecutionModeScope,
  ): Promise<{ exists: boolean; mode: ExecutionMode | null }>;
  /** 当前线程的工具策略（tool-pre-execute 拦截与 deep-agent 工具门共用）。 */
  resolveToolPolicy(threadId: string): ToolPolicy;
}

export function createExecutionModeService(
  deps: { store?: ExecutionModeStore } = {},
): ExecutionModeService {
  const active = new Map<string, ExecutionMode>();
  const known = new Set(BUILTIN_EXECUTION_MODES.map((m) => m.id));
  return {
    listModes() {
      return BUILTIN_EXECUTION_MODES.map(
        ({ id, label, description, inputDirective }) => ({
          id,
          label,
          description,
          ...(inputDirective ? { inputDirective } : {}),
        }),
      );
    },
    getMode(threadId) {
      return active.get(threadId) ?? "agent";
    },
    async activate(threadId, mode, scope) {
      if (!known.has(mode)) {
        throw new Error(`[agent-modes] 未知执行模式 ${mode}（fail loud）。`);
      }
      active.set(threadId, mode);
      if (scope && deps.store) {
        await deps.store.save(scope.workspaceId, threadId, mode);
      }
    },
    async hydrate(threadId, scope) {
      const cached = active.get(threadId);
      if (cached) {
        return cached;
      }
      const row = deps.store
        ? await deps.store.lookup(scope.workspaceId, threadId)
        : { exists: false, mode: null };
      const mode = row.mode ?? "agent";
      active.set(threadId, mode);
      return mode;
    },
    async lookup(threadId, scope) {
      if (!deps.store) {
        return { exists: false, mode: active.get(threadId) ?? null };
      }
      return deps.store.lookup(scope.workspaceId, threadId);
    },
    resolveToolPolicy(threadId) {
      return policyForMode(this.getMode(threadId));
    },
  };
}
