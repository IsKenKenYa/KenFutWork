import { type StructuredTool, tool } from "@langchain/core/tools";
import { type ZodTypeAny, z } from "zod";
import { ToolDeniedError } from "../kernel/context.js";
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
    async (args: Record<string, unknown>) => {
      try {
        return await definition.execute(
          args as Record<string, unknown>,
          execCtx,
        );
      } catch (error) {
        /**
         * 权限拒绝是**工具级结果**，不是运行级失败。
         *
         * 原先 `ToolDeniedError` 从工具节点抛出，会中断整轮 run（实测表现为默认权限档下
         * 任何 `mcp__*` 调用都以一个与因果无关的 LangChain 中间件错误收场）。这里转成
         * 结构化结果交回模型，让它改道（请求审批 / 换方案），而不是把整轮打断。
         */
        if (error instanceof ToolDeniedError) {
          // 用纯字符串：工具结果的最兼容形态。结构化对象虽也能用，但在
          // 「模型偶发返回异常工具调用」时更易触发上游中间件的消息校验问题。
          return `工具 ${definition.name} 被拒绝（当前权限档位需审批，需用户批准或改用它法）。原因：${error.message}`;
        }
        throw error;
      }
    },
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
