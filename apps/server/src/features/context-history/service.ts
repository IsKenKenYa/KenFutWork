import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  ContextHistoryArchiveBindings,
  ContextHistoryArchiveReader,
} from "./types.js";

function requireOwner(owner: ToolExecutionContext) {
  const handle = owner.scopeHandle;
  if (!handle || !owner.actor || !owner.runId || !owner.threadId)
    throw new Error("历史归档必须绑定真实Task与运行线程。");
  const scope = handle.describe();
  if (
    owner.actor.instanceId !== scope.instanceId ||
    (owner.instanceId && owner.instanceId !== scope.instanceId) ||
    (owner.taskWorkContext &&
      (owner.taskWorkContext.scope.taskId !== scope.taskId ||
        owner.taskWorkContext.branchGeneration !== handle.branchGeneration))
  )
    throw new Error("历史归档所属Task或分支不匹配。");
  return handle;
}

/** Private Run authority; validates native thread plus stored scope/branch on every IO. */
export function createContextHistoryArchiveAuthority(
  owner: ToolExecutionContext,
) {
  const handle = requireOwner(owner);
  const expected = handle.describe();
  const branchGeneration = handle.branchGeneration;
  const nativeThreadId = owner.threadId;
  return async (threadId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    owner.signal?.throwIfAborted();
    if (threadId !== nativeThreadId)
      throw new Error("历史归档不属于当前Task原生分支。");
    await handle.resolvePath(expected.rootDirectory, "read");
    const current = handle.describe();
    if (
      current.instanceId !== expected.instanceId ||
      current.projectId !== expected.projectId ||
      current.taskId !== expected.taskId ||
      current.generation !== expected.generation ||
      handle.branchGeneration !== branchGeneration
    )
      throw new Error("历史归档所属Task授权已失效。");
    signal?.throwIfAborted();
    owner.signal?.throwIfAborted();
  };
}

export function createContextHistoryArchiveBindings(
  settings?: Pick<SettingsService, "getInstanceSettings">,
): ContextHistoryArchiveBindings {
  const providers = new WeakMap<
    ExecutionScopeHandle,
    {
      owner: ToolExecutionContext;
      read: ContextHistoryArchiveReader;
      authorize: ReturnType<typeof createContextHistoryArchiveAuthority>;
    }
  >();
  return {
    bind(owner, read) {
      const handle = requireOwner(owner);
      const previous = providers.get(handle);
      if (
        previous &&
        (previous.owner.runId !== owner.runId ||
          previous.owner.threadId !== owner.threadId)
      )
        throw new Error("历史归档不能覆盖其他运行的绑定。");
      const registration = {
        owner: { ...owner },
        read,
        authorize: createContextHistoryArchiveAuthority(owner),
      };
      providers.set(handle, registration);
      return () => {
        if (providers.get(handle) === registration) providers.delete(handle);
      };
    },
    async read(input, execution) {
      execution.signal?.throwIfAborted();
      const handle = requireOwner(execution);
      const provider = providers.get(handle);
      if (
        !provider ||
        provider.owner.runId !== execution.runId ||
        provider.owner.threadId !== execution.threadId ||
        provider.owner.actor?.instanceId !== execution.actor?.instanceId ||
        provider.owner.actor?.accessClientId !== execution.actor?.accessClientId
      )
        throw new Error("当前运行没有可读取的历史归档。");
      const threadId = execution.threadId;
      if (!threadId) throw new Error("历史归档缺少运行线程。");
      const pageBudget =
        settings && execution.actor
          ? (
              await settings.getInstanceSettings(
                execution.actor,
                handle.describe().instanceId,
              )
            ).codeReadPageCharacters
          : AGENT_GOVERNANCE_DEFAULTS.codeReadPageCharacters;
      const limit = input.limit ?? pageBudget;
      if (limit > pageBudget)
        throw new Error(`历史分页范围超过实例设置上限（${pageBudget}）。`);
      await provider.authorize(threadId, execution.signal);
      const result = await provider.read({
        ...input,
        limit,
        ...(execution.signal ? { signal: execution.signal } : {}),
      });
      await provider.authorize(threadId, execution.signal);
      return result;
    },
  };
}
