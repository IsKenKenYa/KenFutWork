import { randomUUID } from "node:crypto";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { AgentMiddleware } from "langchain";

/** 模型调用身份是事实源；LangChain run_id 不参与主/子工具配对。 */
export function createToolLifecycleMiddleware(
  identity: { agentCallId?: string; agentName?: string } = {},
): AgentMiddleware {
  return {
    name: "kenfutwork-tool-lifecycle",
    wrapToolCall: async (request, handler) => {
      const toolCallId = request.toolCall.id ?? randomUUID();
      const toolName = request.toolCall.name;
      const entry = { toolCallId, toolName, ...identity };
      await dispatchCustomEvent("kenfutwork.tool", {
        ...entry,
        phase: "started",
        input: request.toolCall.args,
      });
      try {
        const output = await handler({
          ...request,
          toolCall: { ...request.toolCall, id: toolCallId },
        });
        await dispatchCustomEvent("kenfutwork.tool", {
          ...entry,
          phase: "completed",
          output,
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
