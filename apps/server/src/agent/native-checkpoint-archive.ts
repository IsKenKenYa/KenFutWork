import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { createDeepAgent } from "deepagents";
import type { ContextArchivePage } from "../features/context-history/types.js";
import type { AgentContextHistoryReference } from "./context-history.js";
import { createNativeContextArchiveReader } from "./native-context-archive.js";
import { encodeNativeContextReference } from "./native-context-reference.js";

export const nativeArchivePrefix = "kfw-context-history:";
export interface NativeArchiveBinding {
  reference: AgentContextHistoryReference;
  uri: string;
  sessionId: string;
}
export function encodeNativeArchiveBinding(
  reference: AgentContextHistoryReference,
): NativeArchiveBinding {
  const sessionId = Buffer.from(JSON.stringify(reference)).toString(
    "base64url",
  );
  return {
    reference,
    sessionId,
    uri: `${nativeArchivePrefix}/${sessionId}.md`,
  };
}
export interface NativeCheckpointArchive {
  bind(input: {
    config: RunnableConfig;
    messages: BaseMessage[];
    signal?: AbortSignal;
  }): Promise<NativeArchiveBinding>;
  read(input: {
    reference: AgentContextHistoryReference;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ContextArchivePage>;
}
export function referenceFromNativeArchiveUri(
  uri: string,
): AgentContextHistoryReference {
  const match = /^kfw-context-history:\/([A-Za-z0-9_-]+)\.md$/.exec(uri);
  if (!match?.[1]) throw new Error("历史归档引用无效。");
  const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  if (
    !value ||
    typeof value.adapter !== "string" ||
    typeof value.key !== "string"
  )
    throw new Error("历史归档引用无效。");
  return { adapter: value.adapter, key: value.key };
}

/** Native task configs name the executing node; checkpoint_map pins its parent graph's input checkpoint. */
export function nativeArchiveCheckpointConfig(
  config: RunnableConfig,
): RunnableConfig {
  const value = config.configurable;
  const threadId = value?.thread_id;
  const namespace = value?.checkpoint_ns ?? "";
  if (typeof threadId !== "string" || typeof namespace !== "string")
    throw new Error("历史归档缺少真实Task线程。");
  if (typeof value?.checkpoint_id === "string")
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: namespace,
        checkpoint_id: value.checkpoint_id,
      },
    };
  const parentNamespace = namespace.includes("|")
    ? namespace.slice(0, namespace.lastIndexOf("|"))
    : "";
  const map = value?.checkpoint_map;
  const checkpointId =
    map && typeof map === "object" && Object.hasOwn(map, parentNamespace)
      ? map[parentNamespace]
      : undefined;
  if (typeof checkpointId !== "string")
    throw new Error("历史归档缺少精确checkpoint引用。");
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: parentNamespace,
      checkpoint_id: checkpointId,
    },
  };
}

/** A receipt for existing durable native messages, never a second disk archive or a file permission. */
export function createNativeCheckpointArchive(
  getAgent: () => ReturnType<typeof createDeepAgent>,
  authorize: (
    reference: AgentContextHistoryReference,
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<void>,
): NativeCheckpointArchive {
  return {
    async bind({ config, messages, signal }) {
      signal?.throwIfAborted();
      config = nativeArchiveCheckpointConfig(config);
      const threadId = config.configurable?.thread_id;
      if (typeof threadId !== "string")
        throw new Error("历史归档缺少真实Task线程。");
      const requested = encodeNativeContextReference(threadId, config);
      if (requested) await authorize(requested, threadId, signal);
      signal?.throwIfAborted();
      const snapshot = await getAgent().graph.getState(config);
      const reference = snapshot.createdAt
        ? encodeNativeContextReference(threadId, snapshot.config)
        : null;
      if (requested && reference?.key !== requested.key)
        throw new Error("已记录的历史归档不可用。");
      if (!reference || !Array.isArray(snapshot.values.messages))
        throw new Error("历史原文尚未持久化，无法压缩。");
      const stored = snapshot.values.messages as BaseMessage[];
      // Full native messages, including roles/tool IDs, must match the checkpoint exactly.
      if (
        JSON.stringify(stored.map((message) => message.toDict())) !==
        JSON.stringify(messages.map((message) => message.toDict()))
      )
        throw new Error("历史原文与checkpoint不一致，无法压缩。");
      await authorize(reference, threadId, signal);
      signal?.throwIfAborted();
      return encodeNativeArchiveBinding(reference);
    },
    read(input) {
      return createNativeContextArchiveReader(getAgent(), authorize)(input);
    },
  };
}
