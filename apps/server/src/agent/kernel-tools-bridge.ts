import { ToolMessage } from "@langchain/core/messages";
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

/** Shared adapter result assembly; receipts and native bridge use the same actual result. */
export function kernelToolResultParts(output: unknown) {
  const record =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : undefined;
  return [
    Array.isArray(record?.modelContent) ? record.modelContent : output,
    {
      canonicalOutput: record?.canonicalOutput ?? output,
      ...(record?.display ? { display: record.display } : {}),
    },
  ] as const;
}

function failedToolResult(
  name: string,
  toolCallId: string | undefined,
  parts: ReturnType<typeof kernelToolResultParts>,
) {
  if (!toolCallId) return parts;
  const [content, artifact] = parts;
  return [
    new ToolMessage({
      tool_call_id: toolCallId,
      name,
      status: "error",
      content: Array.isArray(content)
        ? content
        : typeof content === "string"
          ? content
          : JSON.stringify(content),
      artifact,
    }),
    artifact,
  ];
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
        const parts = kernelToolResultParts(output);
        if (
          output !== null &&
          typeof output === "object" &&
          "isError" in output &&
          output.isError === true
        ) {
          return failedToolResult(definition.name, toolCallId, parts);
        }
        return parts;
      } catch (error) {
        // 权限拒绝按原调用回复；没有调用编号的直接调用继续返回可读文本。
        if (error instanceof ToolDeniedError) {
          const { denial } = error;
          const text = toolCallId
            ? denial.error
            : `工具 ${definition.name} 未执行：${denial.error}`;
          return failedToolResult(definition.name, toolCallId, [
            text,
            { canonicalOutput: denial },
          ]);
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
