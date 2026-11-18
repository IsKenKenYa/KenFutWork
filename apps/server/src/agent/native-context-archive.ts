import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { createDeepAgent } from "deepagents";
import type { ContextArchivePage } from "../features/context-history/types.js";
import type { AgentContextHistoryReference } from "./context-history.js";
import { decodeNativeContextReference } from "./native-context-reference.js";

/** Readonly checkpoint resource. The trusted host validates exact reference ownership (instance, Task, native thread and branch), and fresh Task access per read. */
export function createNativeContextArchiveReader(
  agent: ReturnType<typeof createDeepAgent>,
  authorize: (
    reference: AgentContextHistoryReference,
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<void>,
): (input: {
  reference: AgentContextHistoryReference;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}) => Promise<ContextArchivePage> {
  return async ({
    reference,
    offset = 0,
    limit = AGENT_GOVERNANCE_DEFAULTS.codeReadPageCharacters,
    signal,
  }) => {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new Error("历史分页范围无效。");
    const key = decodeNativeContextReference(reference);
    await authorize(reference, key.threadId, signal);
    signal?.throwIfAborted();
    const snapshot = await agent.graph.getState({
      configurable: {
        thread_id: key.threadId,
        checkpoint_ns: key.namespace,
        checkpoint_id: key.checkpointId,
      },
    });
    signal?.throwIfAborted();
    if (
      !snapshot.createdAt ||
      snapshot.config.configurable?.checkpoint_id !== key.checkpointId ||
      snapshot.config.configurable?.thread_id !== key.threadId ||
      (snapshot.config.configurable?.checkpoint_ns ?? "") !== key.namespace ||
      !Array.isArray(snapshot.values.messages)
    )
      throw new Error("已记录的历史归档不可用。");
    const text = JSON.stringify(snapshot.values.messages);
    if (offset > text.length) throw new Error("历史分页范围无效。");
    // Recheck after storage IO so a revoked or superseded Task cannot publish a stale read.
    await authorize(reference, key.threadId, signal);
    signal?.throwIfAborted();
    const end = Math.min(offset + limit, text.length);
    return {
      text: text.slice(offset, end),
      nextOffset: end < text.length ? end : null,
      totalCodeUnits: text.length,
    };
  };
}
