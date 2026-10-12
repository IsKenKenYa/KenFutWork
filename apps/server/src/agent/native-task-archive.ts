import type { createDeepAgent } from "deepagents";
import { createContextHistoryArchiveAuthority } from "../features/context-history/service.js";
import type { ToolExecutionContext } from "../kernel/types.js";
import { createNativeCheckpointArchive } from "./native-checkpoint-archive.js";
import { decodeNativeContextReference } from "./native-context-reference.js";

/** Product Task authority surrounds the fixed native checkpoint adapter; URI is never authority. */
export function createNativeTaskArchive(
  getAgent: () => ReturnType<typeof createDeepAgent>,
  execution: ToolExecutionContext | undefined,
  preset: "code" | "design",
) {
  const authority = execution?.scopeHandle
    ? createContextHistoryArchiveAuthority(execution)
    : undefined;
  return createNativeCheckpointArchive(
    getAgent,
    async (reference, threadId, signal) => {
      if (
        !authority ||
        !execution?.scopeHandle ||
        execution.scopeHandle.preset !== preset
      )
        throw new Error("历史归档必须绑定真实Task与运行线程。");
      const key = decodeNativeContextReference(reference);
      if (key.threadId !== threadId || key.namespace !== "")
        throw new Error("历史归档不属于当前Task原生分支。");
      await authority(threadId, signal);
    },
  );
}
