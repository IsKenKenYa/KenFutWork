import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";
import type {
  AgentEventIdentity,
  AgentRunExtensionContext,
} from "../../agent/run-extension.js";
import type { ToolExecutionContext } from "../../kernel/types.js";

export interface CodeGuideMessage {
  id: string;
  text: string;
}

export interface CodeGuideConsumer {
  consumeGuides(context: ToolExecutionContext): Promise<CodeGuideMessage[]>;
  hasPendingGuides(context: ToolExecutionContext): Promise<boolean>;
}

/** 当前主 Run 的模型边界消费者；消息身份与持久投影由 Code UI 提供。 */
export function createCodeGuideMiddleware(
  consumer: CodeGuideConsumer,
  identity: AgentEventIdentity,
  context?: AgentRunExtensionContext,
): AgentMiddleware {
  const execution = context?.execution;
  const main =
    identity.agentCallId === undefined &&
    !!execution?.actor &&
    !!execution.runId &&
    execution.scopeHandle?.role === "main" &&
    execution.scopeHandle.agentId === "main";
  return {
    name: "CodeGuideMailbox",
    async beforeModel(state) {
      if (!main || !execution) return {};
      const guides = await consumer.consumeGuides(execution);
      const existingIds = new Set(state.messages.map((message) => message.id));
      const messages = guides
        .filter((guide) => !existingIds.has(guide.id))
        .map(
          (guide) => new HumanMessage({ id: guide.id, content: guide.text }),
        );
      return messages.length ? { messages } : {};
    },
    afterModel: {
      canJumpTo: ["model"],
      async hook(state) {
        if (!main || !execution) return {};
        const last = state.messages.at(-1);
        if (!AIMessage.isInstance(last) || last.tool_calls?.length) return {};
        return (await consumer.hasPendingGuides(execution))
          ? { jumpTo: "model" }
          : {};
      },
    },
  };
}
