import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { isCommand } from "@langchain/langgraph";
import type { createDeepAgent } from "deepagents";
import type { AgentMiddleware } from "langchain";

/** 私有DA字段仅在固定版本adapter内读取，产品事件只携带已确认checkpoint引用。 */
export function nativeSummaryKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as {
    cutoffIndex?: unknown;
    summaryMessage?: unknown;
    filePath?: unknown;
  };
  if (
    typeof event.cutoffIndex !== "number" ||
    !HumanMessage.isInstance(event.summaryMessage)
  )
    return null;
  return JSON.stringify([
    event.cutoffIndex,
    event.summaryMessage.id ?? null,
    event.summaryMessage.content,
    event.filePath ?? null,
  ]);
}

export function createNativeCompactionTracker(middleware: AgentMiddleware) {
  const original = middleware.wrapModelCall;
  if (!original) throw new Error("当前摘要middleware缺少wrapModelCall接口。");
  const candidates = new Map<string, Set<string>>();
  const tracked: AgentMiddleware = {
    ...middleware,
    wrapModelCall: async (request, handler) => {
      const result = await original(request, handler);
      const threadId = request.runtime.configurable?.thread_id;
      if (threadId && isCommand(result)) {
        const update = Array.isArray(result.update)
          ? Object.fromEntries(result.update)
          : result.update;
        const key = nativeSummaryKey(update?._summarizationEvent);
        if (key) {
          const pending = candidates.get(threadId) ?? new Set<string>();
          pending.add(key);
          candidates.set(threadId, pending);
        }
      }
      return result;
    },
  };

  const attach = (agent: ReturnType<typeof createDeepAgent>) => {
    const originalEvents = agent.streamEvents.bind(agent);
    type Arguments = Parameters<typeof agent.streamEvents>;
    const streamEvents = (...args: Arguments) => {
      const native = originalEvents(...args);
      const config = args[1] as
        | (RunnableConfig & { version?: string })
        | undefined;
      if (config?.version === "v3") return native;
      const threadId = config?.configurable?.thread_id;
      async function* confirmedEvents() {
        let sourceError: unknown;
        let failed = false;
        try {
          for await (const event of native) yield event;
        } catch (error) {
          sourceError = error;
          failed = true;
        }
        if (typeof threadId === "string" && candidates.has(threadId)) {
          try {
            const snapshot = await agent.graph.getState({
              configurable: {
                thread_id: threadId,
                ...(typeof config?.configurable?.checkpoint_ns === "string"
                  ? { checkpoint_ns: config.configurable.checkpoint_ns }
                  : {}),
              },
            });
            const checkpointId = snapshot.config.configurable?.checkpoint_id;
            const committed =
              typeof checkpointId === "string"
                ? await agent.graph.getState({
                    configurable: {
                      thread_id: threadId,
                      checkpoint_ns:
                        snapshot.config.configurable?.checkpoint_ns ?? "",
                      checkpoint_id: checkpointId,
                    },
                  })
                : null;
            // current读取会合并pending writes；只有显式checkpoint里的摘要才已提交。
            const key = nativeSummaryKey(committed?.values._summarizationEvent);
            if (
              key &&
              committed?.createdAt &&
              committed.config.configurable?.checkpoint_id === checkpointId &&
              candidates.get(threadId)?.has(key) &&
              typeof checkpointId === "string"
            ) {
              yield {
                event: "on_custom_event",
                name: "kenfutwork.compaction.applied",
                run_id: threadId,
                metadata: {},
                data: { output: { checkpointId } },
              };
            }
          } catch (error) {
            console.warn(
              "[compaction] 已提交摘要引用读取失败：",
              error instanceof Error ? error.message : "未知读取错误",
            );
          } finally {
            candidates.delete(threadId);
          }
        }
        if (failed) throw sourceError;
      }
      return IterableReadableStream.fromAsyncGenerator(confirmedEvents());
    };
    // 固定SDK提供v1/v2/v3重载；现Harness消费v2，保留native其它方法和graph身份。
    agent.streamEvents = streamEvents as typeof agent.streamEvents;
    return agent;
  };
  return { middleware: tracked, attach };
}
