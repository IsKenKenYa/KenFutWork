import {
  encodeNativeArchiveBinding,
  nativeArchivePrefix,
  referenceFromNativeArchiveUri,
} from "./native-checkpoint-archive.js";
import {
  decodeNativeContextReference,
  encodeNativeContextReference,
} from "./native-context-reference.js";

export interface NativeArchiveCloneScope {
  sourceThreadId: string;
  targetThreadId: string;
  namespace: string;
  checkpointIds: ReadonlySet<string>;
}

/** Only references whose native raw checkpoint was actually copied can change owner. */
export function createNativeArchiveRebinder(scope: NativeArchiveCloneScope) {
  const uri = (value: string): string => {
    if (!value.startsWith(nativeArchivePrefix)) return value;
    const key = decodeNativeContextReference(
      referenceFromNativeArchiveUri(value),
    );
    if (
      key.threadId !== scope.sourceThreadId ||
      key.namespace !== scope.namespace ||
      !scope.checkpointIds.has(key.checkpointId)
    )
      throw new Error("历史归档不属于已复制的上下文祖先链。");
    const reference = encodeNativeContextReference(scope.targetThreadId, {
      configurable: {
        checkpoint_ns: key.namespace,
        checkpoint_id: key.checkpointId,
      },
    });
    if (!reference) throw new Error("历史归档无法重绑定目标thread。");
    return encodeNativeArchiveBinding(reference).uri;
  };
  return {
    uri,
    text: (text: string) =>
      text.replace(/kfw-context-history:\/[A-Za-z0-9_-]+\.md/g, uri),
  };
}
