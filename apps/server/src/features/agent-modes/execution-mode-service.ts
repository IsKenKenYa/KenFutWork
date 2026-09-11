import type { ExecutionMode } from "@loomic/shared";

/**
 * agentModes 缝（DEC-3，P6）：只管激活/切换/持久化当前模式。
 * v1 内置 agent（默认自主循环）+ plan（先规划待批准再执行）；goal/loop/solo
 * 以 capabilities 贡献增量加入，不改 loop。模式是「引导不是强制」（§4.6）。
 */

export const BUILTIN_EXECUTION_MODES: Array<{
  id: ExecutionMode;
  label: string;
  description: string;
  /** plan 模式注入的输入前缀（各模式逻辑独立，不做大一统 mode 引擎）。 */
  inputDirective?: string;
}> = [
  {
    id: "agent",
    label: "自主执行",
    description: "默认：agent 自主循环完成任务。",
  },
  {
    id: "plan",
    label: "先规划",
    description: "先产出分步计划待用户批准，再逐步执行。",
    inputDirective:
      '<execution_mode name="plan">\n请先给出分步执行计划并等待用户批准，再开始实际修改；未获批准前不要执行不可逆操作。\n</execution_mode>',
  },
];

export interface ExecutionModeService {
  listModes(): Array<{ id: ExecutionMode; label: string; description: string }>;
  /** 当前线程激活的模式；未激活返回默认 agent。 */
  getMode(threadId: string): ExecutionMode;
  /** 激活/切换当前线程模式；未知模式 fail loud。 */
  activate(threadId: string, mode: ExecutionMode): void;
}

export function createExecutionModeService(): ExecutionModeService {
  const active = new Map<string, ExecutionMode>();
  const known = new Set(BUILTIN_EXECUTION_MODES.map((m) => m.id));
  return {
    listModes() {
      return BUILTIN_EXECUTION_MODES.map(({ id, label, description }) => ({
        id,
        label,
        description,
      }));
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
  };
}
