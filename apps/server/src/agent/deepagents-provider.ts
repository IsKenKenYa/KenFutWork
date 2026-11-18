import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { publicToolOutput } from "../features/code-ui/tool-lifecycle.js";
import { OwnedToolInterruption } from "../kernel/owned-tool-interruption.js";
import { publicToolArguments } from "../kernel/tool-arguments.js";
import type { ToolExecutionObservation } from "../kernel/types.js";
import type { KenFutWorkAgent } from "./deep-agent.js";
import { kernelToolResultParts } from "./kernel-tools-bridge.js";
import type { AgentRuntimeProvider } from "./provider-contract.js";
import {
  adaptDeepAgentStream,
  projectCanonicalToolEvent,
} from "./stream-adapter.js";

/** Private default binding: model/backend/persistence/factory are deliberately still native. */
export interface DeepAgentsProviderBinding {
  createAgent(): KenFutWorkAgent;
  config(): Parameters<KenFutWorkAgent["streamEvents"]>[1] & object;
}

/** Existing factory and raw-event adaptation are reused, never a second agent loop. */
export function createDeepAgentsProvider(
  binding: DeepAgentsProviderBinding,
): AgentRuntimeProvider {
  return {
    id: "deepagents",
    open(context) {
      const native = binding.createAgent();
      return {
        ...(native.contextHistory
          ? { contextHistory: native.contextHistory }
          : {}),
        release: () => native.releaseContextHistory?.(),
        stream(input) {
          const messages = input.messages.map(
            (message) =>
              new HumanMessage({
                ...(message.id !== undefined ? { id: message.id } : {}),
                // Current owned multimodal payloads remain JSON; SDK conversion is private to this adapter.
                content: message.content as HumanMessage["content"],
              }),
          );
          const stream = (async function* () {
            const config = binding.config();
            const signal = context.signal;
            if (!signal) {
              yield* native.streamEvents({ messages }, config);
              return;
            }
            const forwarded = new AbortController();
            const onAbort = () => forwarded.abort(new OwnedToolInterruption());
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            try {
              yield* native.streamEvents(
                { messages },
                { ...config, signal: forwarded.signal },
              );
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          })();
          return adaptDeepAgentStream({
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            canonicalToolEvents: native.canonicalToolEvents === true,
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.now ? { now: context.now } : {}),
            ...(context.onUsage ? { onUsage: context.onUsage } : {}),
            ...(context.toolComposition
              ? { toolComposition: context.toolComposition }
              : {}),
            ...(context.autoCompact
              ? { autoCompact: context.autoCompact }
              : {}),
            ...(context.idleTimeoutMs !== undefined
              ? { idleTimeoutMs: context.idleTimeoutMs }
              : {}),
            ...(context.abortRun ? { abortRun: context.abortRun } : {}),
            stream,
          });
        },
      };
    },
  };
}

/** Reuse the existing native result assembly and canonical mapper for actual executor facts. */
export async function projectKernelToolExecution(
  fact: ToolExecutionObservation,
  identity: { runId: string; sessionId: string; conversationId: string },
) {
  if (!fact.toolCallId) throw new Error("工具执行缺少调用身份。");
  let output: unknown;
  if (fact.phase === "completed") {
    const [content, artifact] = kernelToolResultParts(fact.output);
    const messageContent =
      typeof content === "string" ||
      (Array.isArray(content) &&
        content.every(
          (part) => part !== null && typeof part === "object" && "type" in part,
        ))
        ? content
        : JSON.stringify(content ?? null);
    output = publicToolOutput(
      new ToolMessage({
        content: messageContent as ToolMessage["content"],
        tool_call_id: fact.toolCallId,
        name: fact.definition.name,
        artifact,
      }),
    );
  }
  const events = [];
  for await (const event of projectCanonicalToolEvent(
    {
      phase: fact.phase,
      toolCallId: fact.toolCallId,
      toolName: fact.definition.name,
      ...(fact.phase === "started"
        ? { input: publicToolArguments(fact.definition, fact.args) }
        : {}),
      ...(fact.phase === "completed" ? { output } : {}),
      ...(fact.error ? { error: fact.error } : {}),
    },
    identity,
  ))
    events.push(event);
  return events;
}
