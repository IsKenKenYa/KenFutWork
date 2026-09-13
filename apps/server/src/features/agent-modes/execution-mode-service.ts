import type { ExecutionMode } from "@loomic/shared";

/**
 * agentModes 缝（DEC-3，P6）：只管激活/切换/持久化当前模式。
 * 指令引导（inputDirective）+ 工具硬约束（resolveToolPolicy）双层：
 * plan/solo 在引导之外还有 tool-pre-execute 级别的强制拦截（§4.6「引导不是强制」
 * 仅适用于 goal/loop/creative 等无法机械判定的模式）。
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
      '<execution_mode name="creative">\n本轮为创造模式，目标是产出可安装的插件/技能产物：\n1. 先与用户确认交付物形态（SKILL.md 技能 / 插件 bundle 目录）；\n2. 在工作目录按规范生成产物——技能以 SKILL.md 开头（YAML frontmatter 含 name/description，正文为操作指引，附属文件与 SKILL.md 同目录）；\n3. 产物完成后明确告知用户文件位置，并指引其通过技能市场/插件市场导入安装；\n4. 不要擅自删除或覆盖既有产物，生成前先检查目录现状。\n</execution_mode>',
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
  /** 当前线程激活的模式；未激活返回默认 agent。 */
  getMode(threadId: string): ExecutionMode;
  /** 激活/切换当前线程模式；未知模式 fail loud。 */
  activate(threadId: string, mode: ExecutionMode): void;
  /** 当前线程的工具策略（tool-pre-execute 拦截与 deep-agent 工具门共用）。 */
  resolveToolPolicy(threadId: string): ToolPolicy;
}

export function createExecutionModeService(): ExecutionModeService {
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
    activate(threadId, mode) {
      if (!known.has(mode)) {
        throw new Error(`[agent-modes] 未知执行模式 ${mode}（fail loud）。`);
      }
      active.set(threadId, mode);
    },
    resolveToolPolicy(threadId) {
      return policyForMode(this.getMode(threadId));
    },
  };
}
