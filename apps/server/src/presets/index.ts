import type { ToolDefinition, ToolScope } from "../kernel/types.js";

/**
 * agent preset（DEC-2，P7）：design/code 是会话级能力集组合，不是部署级 profile。
 * 基础能力层（shared）两 preset 恒可用；差异只在工具 scope 过滤（§4.5）。
 * profiles/ 管进程形态，presets/ 管产品模式——两个维度互不混用。
 */

export interface AgentPreset {
  id: "design" | "code";
  label: string;
  toolScopes: readonly ToolScope[];
}

export const designPreset: AgentPreset = {
  id: "design",
  label: "Design",
  toolScopes: ["shared", "design"],
};

export const codePreset: AgentPreset = {
  id: "code",
  label: "Code",
  toolScopes: ["shared", "code"],
};

export const PRESETS = { design: designPreset, code: codePreset } as const;

/** 按 preset 过滤工具子集（shared 恒可用，能力共享、激活按模式）。 */
export function toolsForPreset(
  tools: ToolDefinition[],
  preset: AgentPreset,
): ToolDefinition[] {
  return tools.filter((tool) => preset.toolScopes.includes(tool.scope));
}
