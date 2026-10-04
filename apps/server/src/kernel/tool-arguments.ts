import type { ToolDefinition } from "./types.js";

/** 公共投影只收到副本；投影异常时隐藏参数，绝不回落泄漏原值。 */
export function publicToolArguments(tool: Pick<ToolDefinition, "projectArguments"> | undefined, args: Record<string, unknown>): Record<string, unknown> {
  try {
    const copied = structuredClone(args);
    const projected = tool?.projectArguments ? tool.projectArguments(copied) : copied;
    return projected && typeof projected === "object" && !Array.isArray(projected) ? projected : {};
  } catch { return {}; }
}
