import { randomUUID } from "node:crypto";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { ToolMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";
import type { AgentRunExtensionContext } from "../../agent/run-extension.js";
import { publicToolArguments } from "../../kernel/tool-arguments.js";

/** 展示是独立公开投影；不改handler返回值、canonical artifact或模型内容。 */
function publicToolOutput(output: unknown): unknown {
  if (!ToolMessage.isInstance(output)) return output;
  const artifact = output.artifact as
    | { canonicalOutput?: unknown; display?: unknown }
    | undefined;
  const canonical = artifact?.canonicalOutput;
  if (
    !artifact?.display ||
    !canonical ||
    typeof canonical !== "object" ||
    Array.isArray(canonical)
  )
    return output;
  const projected = {
    ...structuredClone(canonical),
    display: structuredClone(artifact.display),
  };
  const failures =
    "failures" in projected && Array.isArray(projected.failures)
      ? projected.failures
      : [];
  return new ToolMessage({
    content: output.content,
    tool_call_id: output.tool_call_id,
    ...(output.name ? { name: output.name } : {}),
    ...(failures.length ? { status: "error" as const } : output.status ? { status: output.status } : {}),
    artifact: { canonicalOutput: projected },
  });
}

/** 模型调用身份是事实源；LangChain run_id 不参与主/子工具配对。 */
export function createToolLifecycleMiddleware(
  identity: { agentCallId?: string; agentName?: string } = {},
  context?: AgentRunExtensionContext,
): AgentMiddleware {
  return {
    name: "kenfutwork-tool-lifecycle",
    wrapToolCall: async (request, handler) => {
      const toolCallId = request.toolCall.id ?? randomUUID();
      const toolName = request.toolCall.name;
      const entry = { toolCallId, toolName, ...identity };
      const definition = context?.registry
        .resolveRunTools(context.resolution)
        .find((tool) => tool.name === toolName);
      await dispatchCustomEvent("kenfutwork.tool", {
        ...entry,
        phase: "started",
        input: publicToolArguments(definition, request.toolCall.args),
      });
      try {
        const output = await handler({
          ...request,
          toolCall: { ...request.toolCall, id: toolCallId },
        });
        await dispatchCustomEvent("kenfutwork.tool", {
          ...entry,
          phase: "completed",
          output: publicToolOutput(output),
        });
        return output;
      } catch (error) {
        await dispatchCustomEvent("kenfutwork.tool", {
          ...entry,
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
