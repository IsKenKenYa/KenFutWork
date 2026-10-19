import { randomUUID } from "node:crypto";
import type { AgentMiddleware } from "langchain";
import { publicToolOutput } from "../features/code-ui/tool-lifecycle.js";
import { findOwnedToolInterruption } from "../kernel/owned-tool-interruption.js";
import { publicToolArguments } from "../kernel/tool-arguments.js";
import type { AgentRunExtensionContext } from "./run-extension.js";
import { projectCanonicalToolEvent } from "./stream-adapter.js";
import type {
  NativeToolProof,
  ProductToolEvent,
} from "./tool-execution-receipts.js";

/** Private SDK handler proof, never an exemption for all events from an adapter. */
export function createNativeToolProofMiddleware(options: {
  identity: { runId: string; sessionId: string; conversationId: string };
  context?: AgentRunExtensionContext;
  observe(proof: NativeToolProof): Promise<void>;
}): AgentMiddleware {
  return {
    name: "NativeActualToolExecutionProof",
    async wrapToolCall(request, handler) {
      const toolCallId = request.toolCall.id ?? randomUUID();
      const toolName = request.toolCall.name;
      const definition = options.context?.registry
        .resolveRunTools(options.context.resolution)
        .find((tool) => tool.name === toolName);
      const events: ProductToolEvent[] = [];
      for await (const event of projectCanonicalToolEvent(
        {
          phase: "started",
          toolCallId,
          toolName,
          input: publicToolArguments(definition, request.toolCall.args),
        },
        options.identity,
      ))
        events.push(event);
      if (!definition && request.tool)
        await options.observe({
          toolName,
          toolCallId,
          registered: false,
          events,
        });
      try {
        const output = await handler({
          ...request,
          toolCall: { ...request.toolCall, id: toolCallId },
        });
        for await (const event of projectCanonicalToolEvent(
          {
            phase: "completed",
            toolCallId,
            toolName,
            output: publicToolOutput(output),
          },
          options.identity,
        ))
          events.push(event);
        const completed = events.find(
          (event) => event.type === "tool.completed",
        );
        if (!definition && completed?.status === "success" && !request.tool)
          throw new Error("SDK工具成功结果缺少实际handler工具。");
        await options.observe({
          toolName,
          toolCallId,
          registered: Boolean(definition),
          events,
        });
        return output;
      } catch (error) {
        const interruption = findOwnedToolInterruption(error);
        const failed: ProductToolEvent[] = events.filter(
          (event) => event.type === "tool.started",
        );
        for await (const event of projectCanonicalToolEvent(
          {
            phase: interruption ? "cancelled" : "failed",
            toolCallId,
            toolName,
            ...(interruption
              ? {}
              : {
                  error: error instanceof Error ? error.message : String(error),
                }),
          },
          options.identity,
        ))
          failed.push(event);
        await options.observe({
          toolName,
          toolCallId,
          registered: Boolean(definition),
          events: failed,
          ...(interruption ? { interruption } : {}),
        });
        throw error;
      }
    },
  };
}
