import type { ExecutionMode } from "@kenfutwork/shared";

/**
 * 六档执行模式的中文标签（本地兜底；唯一权威仍是服务端 `GET /api/execution-modes`）。
 *
 * 为什么前端也要有一份：模式选择器的标签来自服务端词表，而词表要等会话（`/api/viewer`）
 * 就绪后才拉得动——首屏那一小段时间 `executionModes` 是空数组，选择器**只能渲染原始 id**，
 * 于是用户看到的是英文 `agent`、点开还是空列表（2026-09-19 用户反馈：「它变成英文还是空的」）。
 * 这里与 `apps/server/src/features/agent-modes/execution-mode-service.ts` 的内置六档对齐：
 * 服务端词表到了就用它的（含描述与注入指令），没到也不会把 id 露出来。
 */
export const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
  agent: "自主",
  plan: "计划",
  solo: "对话",
  goal: "目标",
  loop: "循环",
  creative: "创造",
};

/** 词表顺序（与服务端内置顺序一致）：下拉在词表未到之前也按它渲染。 */
export const EXECUTION_MODES_ORDER: readonly ExecutionMode[] = [
  "agent",
  "plan",
  "solo",
  "goal",
  "loop",
  "creative",
];

export type ExecutionModeOption = {
  id: ExecutionMode;
  label: string;
  description?: string | undefined;
  inputDirective?: string | undefined;
};

/** 取某个模式的中文标签：优先服务端词表，回落到本地兜底，最后才是 id 本身。 */
export function executionModeLabel(
  id: ExecutionMode,
  vocabulary: ReadonlyArray<ExecutionModeOption> = [],
): string {
  return (
    vocabulary.find((mode) => mode.id === id)?.label ??
    EXECUTION_MODE_LABELS[id] ??
    id
  );
}

/**
 * 下拉选项：服务端词表为准，缺失的档位用本地兜底补齐（顺序固定）。
 *
 * 用「并集」而不是「词表为空才兜底」：词表可能只到了一部分（例如后端加了新档），
 * 补齐能保证用户永远看得到全部六档。
 */
export function executionModeOptions(
  vocabulary: ReadonlyArray<ExecutionModeOption> = [],
): ExecutionModeOption[] {
  const extra = vocabulary.filter(
    (mode) => !EXECUTION_MODES_ORDER.includes(mode.id),
  );
  return [
    ...EXECUTION_MODES_ORDER.map((id) => ({
      id,
      label: executionModeLabel(id, vocabulary),
    })),
    ...extra,
  ];
}
