import {
  type StructuredTool,
  type ToolRunnableConfig,
  type ToolRuntime,
  tool,
} from "@langchain/core/tools";
import { type ZodTypeAny, z } from "zod";
import { ToolDeniedError } from "../kernel/context.js";
import type { ToolDefinition, ToolExecutionContext } from "../kernel/types.js";

/**
 * 内核工具桥（§4.5「统一工具注册表」的最后一环）：
 * 把 ctx.tools 里的 ToolDefinition（JSON Schema 描述）转换为 deepagents/LangChain
 * 的 StructuredTool，使 MCP / skill / 联网搜索 / 预览 / diff 等工具真正进入模型工具列表。
 * 模型每次调用经此桥透传回 ToolRegistry.execute 的语义（含 guarded 执行由注册表侧保证）。
 */

/** 与 guarded 入口共用 Zod 的 JSON Schema 语义，不另丢 enum/default/union。 */
export function jsonSchemaToZod(schema: Record<string, unknown>): ZodTypeAny {
  return z.fromJSONSchema({ type: "object", ...schema });
}

/** ToolDefinition → LangChain StructuredTool（透传 execute 与执行上下文）。 */
export function kernelToolToStructuredTool(
  definition: ToolDefinition,
  execCtx: ToolExecutionContext = {},
): StructuredTool {
  // 内置工具带原生 zod schema：直用，避免 JSON Schema 往返丢 default/union/enum
  const schema: ZodTypeAny =
    definition.zodSchema ?? jsonSchemaToZod(definition.parameters);
  const dynamic = tool(
    async (args: Record<string, unknown>, runtime: ToolRuntime) => {
      // invoke 期的 run 级输入（附件 assetId→dataURI）在装配期不可得：
      // 从 LangChain RunnableConfig（func 第二参）透传进 execCtx（副本，不污染装配期对象）
      const config =
        runtime.config ?? (runtime as unknown as ToolRunnableConfig);
      const attachmentMap = config.configurable?.user_attachment_map as
        | Record<string, string>
        | undefined;
      const toolCallId = runtime.toolCallId || config.toolCall?.id;
      const effectiveCtx: ToolExecutionContext = {
        ...execCtx,
        ...(attachmentMap ? { userAttachmentMap: attachmentMap } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(config.signal ? { signal: config.signal } : {}),
      };
      try {
        const output = await definition.execute(
          args as Record<string, unknown>,
          effectiveCtx,
        );
        const record =
          output && typeof output === "object" && !Array.isArray(output)
            ? (output as Record<string, unknown>)
            : undefined;
        const content = Array.isArray(record?.modelContent)
          ? record.modelContent
          : output;
        return [
          content,
          {
            canonicalOutput: record?.canonicalOutput ?? output,
            ...(record?.display ? { display: record.display } : {}),
          },
        ];
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
          const text = `工具 ${definition.name} 被拒绝（当前权限档位需审批，需用户批准或改用它法）。原因：${error.message}`;
          return [text, { canonicalOutput: { error: text, status: "denied" } }];
        }
        throw error;
      }
    },
    {
      name: definition.name,
      description: definition.description,
      schema: schema as z.ZodObject<Record<string, ZodTypeAny>>,
      responseFormat: "content_and_artifact",
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
