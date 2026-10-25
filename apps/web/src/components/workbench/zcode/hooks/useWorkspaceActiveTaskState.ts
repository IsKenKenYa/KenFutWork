import { useMemo, useRef } from "react";
import { isLocalWorkspaceTarget, type ZCodeProvider, type ZCodeTaskMeta } from "@zcode/shared";
import { useActiveTaskSnapshotMeta } from "@zui/hooks/useActiveTaskSnapshotMeta.js";
import { useTaskNativeSessionLogFile } from "@zui/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@zui/hooks/useTaskSessionFilePath.js";
import { buildTaskEntityKey } from "@zui/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@zui/lib/zcodeTaskMetaMerge.js";
import { resolveWorkspaceHeaderProvider } from "@zui/lib/workspaceHeaderProvider.js";
import {
  getTaskMeta,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@zui/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@zui/store/taskQueryCacheStore.js";
import { useOptionalProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.lastUnreadAt === right.lastUnreadAt &&
    left.pinRevision === right.pinRevision &&
    areTaskMetaJsonFieldsEqual(left.taskControl, right.taskControl) &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // stream chunk 只更新消息流时，active task meta 经列表/乐观层重新合成后可能字段相同但引用变了。
  // Header/Shell 依赖 memo props；这里复用等价 meta 的旧引用，避免连续流式更新拖动标题栏重渲。
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const directory = useOptionalProjectDirectory();
  const workspaceState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity),
  );
  const activeTaskQueryMeta = useTaskQueryCacheStore((state) => {
    if (!activeTaskId) {
      return null;
    }
    return (
      state.taskMetaByEntityKey[
        buildTaskEntityKey({
          taskId: activeTaskId,
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
        })
      ] ?? null
    );
  });
  const activeTaskMeta = useMemo(() => {
    if (!activeTaskId) {
      return null;
    }

    const legacy = mergeTaskMetaCandidates(getTaskMeta(workspaceState, activeTaskId), activeTaskQueryMeta);
    const local = isLocalWorkspaceTarget({
      workspacePath: workspaceAbsPath,
      workspaceIdentity,
      remoteSessionId: workspaceRemoteSessionId,
    });
    const key = buildTaskEntityKey({ taskId: activeTaskId, workspacePath: workspaceAbsPath, workspaceIdentity });
    const current = local ? directory?.tree.tasks.find((task) => buildTaskEntityKey(task) === key) : undefined;
    // 本机 Header 与原侧栏读取同一项目树事实；其它来源保留原列表与快照消费者。
    return current ? { ...legacy, ...current } : legacy ?? null;
  }, [activeTaskId, activeTaskQueryMeta, workspaceState, directory?.tree.tasks, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId]);

  const activeTaskSnapshotMeta = useActiveTaskSnapshotMeta(
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    activeTaskMeta,
  );
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(
    activeTaskMeta ?? activeTaskSnapshotMeta,
  );
  // store 收尾：taskMessagesByTaskId 已无写入方（旧 ChatView/广播消息回放均退役），
  // 由消息流派生的实时改动摘要恒为空；摘要展示回落到 task meta.changeSummary（持久化侧）。
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
