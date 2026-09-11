import { type StructuredTool, tool } from "@langchain/core/tools";
import { type ZodTypeAny, z } from "zod";

import type { ToolDefinition, ToolExecutionContext } from "../kernel/types.js";

/**
 * 内核工具桥（§4.5「统一工具注册表」的最后一环）：
 * 把 ctx.tools 里的 ToolDefinition（JSON Schema 描述）转换为 deepagents/LangChain
 * 的 StructuredTool，使 MCP / skill / 联网搜索 / 预览 / diff 等工具真正进入模型工具列表。
 * 模型每次调用经此桥透传回 ToolRegistry.execute 的语义（含 guarded 执行由注册表侧保证）。
 */

/** 支持子集的 JSON Schema → zod（深度封顶 4 层，超出降级为 record）。 */
export function jsonSchemaToZod(
  schema: Record<string, unknown>,
  depth = 0,
): ZodTypeAny {
  const type = typeof schema.type === "string" ? schema.type : "object";
  const description =
    typeof schema.description === "string" ? schema.description : undefined;
  const withMeta = (base: ZodTypeAny): ZodTypeAny =>
    description ? base.describe(description) : base;

  switch (type) {
    case "string":
      return withMeta(z.string());
    case "number":
    case "integer":
      return withMeta(z.number());
    case "boolean":
      return withMeta(z.boolean());
    case "array": {
      if (depth > 4) {
        return withMeta(z.array(z.unknown()));
      }
      const items =
        (schema.items as Record<string, unknown> | undefined) ?? undefined;
      return withMeta(
        z.array(
          items
            ? (jsonSchemaToZod(items, depth + 1) as ZodTypeAny)
            : z.unknown(),
        ),
      );
    }
    case "object":
    default: {
      // 递归深度封顶：超过 4 层的嵌套对象降级为 record（防恶意/失控 schema）
      if (depth > 4) {
        return withMeta(z.record(z.string(), z.unknown()));
      }
      const properties =
        (schema.properties as Record<string, Record<string, unknown>>) ?? {};
      const required = Array.isArray(schema.required)
        ? (schema.required as string[])
        : [];
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const base = jsonSchemaToZod(propSchema, depth + 1);
        shape[key] = required.includes(key) ? base : base.optional();
      }
      return withMeta(z.object(shape));
    }
  }
}

/** ToolDefinition → LangChain StructuredTool（透传 execute 与执行上下文）。 */
export function kernelToolToStructuredTool(
  definition: ToolDefinition,
  execCtx: ToolExecutionContext = {},
): StructuredTool {
  const schema = jsonSchemaToZod(definition.parameters);
  const dynamic = tool(
    async (args: Record<string, unknown>) =>
      definition.execute(args as Record<string, unknown>, execCtx),
    {
      name: definition.name,
      description: definition.description,
      schema: schema as z.ZodObject<Record<string, ZodTypeAny>>,
    },
  );
  return dynamic as unknown as StructuredTool;
}

/** 按 preset 过滤后的内核工具 → StructuredTool 列表。 */
export function bridgeKernelTools(
  tools: readonly ToolDefinition[],
  execCtx: ToolExecutionContext = {},
): StructuredTool[] {
  return tools.map((definition) =>
    kernelToolToStructuredTool(definition, execCtx),
  );
}
