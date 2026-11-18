import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentContextHistoryReference } from "./context-history.js";

export function encodeNativeContextReference(
  threadId: string,
  config: RunnableConfig,
): AgentContextHistoryReference | null {
  const checkpointId = config.configurable?.checkpoint_id;
  if (typeof checkpointId !== "string") return null;
  const namespace = config.configurable?.checkpoint_ns;
  return {
    adapter: "deepagents",
    key: JSON.stringify({
      threadId,
      namespace: typeof namespace === "string" ? namespace : "",
      checkpointId,
    }),
  };
}
export function decodeNativeContextReference(
  reference: AgentContextHistoryReference,
): { threadId: string; namespace: string; checkpointId: string } {
  if (reference.adapter !== "deepagents")
    throw new Error("上下文引用不属于当前runtime adapter。");
  const value = JSON.parse(reference.key) as {
    threadId?: unknown;
    namespace?: unknown;
    checkpointId?: unknown;
  };
  if (
    typeof value.threadId !== "string" ||
    typeof value.namespace !== "string" ||
    typeof value.checkpointId !== "string"
  )
    throw new Error("上下文checkpoint引用不完整。");
  return {
    threadId: value.threadId,
    namespace: value.namespace,
    checkpointId: value.checkpointId,
  };
}
