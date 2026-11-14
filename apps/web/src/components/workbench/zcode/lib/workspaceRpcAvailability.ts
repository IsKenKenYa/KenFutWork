import { isLocalWorkspaceTarget } from "@zcode/shared";

interface WorkspaceRpcAvailabilityTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

/**
 * 本机项目工作区也带非空 `workspaceIdentity`（`[projectId, rootDirectory]` 的 JSON）。
 * 判定必须按本机身份解析，不能把「有身份」直接当成远端——否则本地 Git 查询会被关掉，
 * 状态面板永远拿不到仓库摘要。
 */
function isRemoteWorkspaceRpcTarget(
  target: WorkspaceRpcAvailabilityTarget,
): boolean {
  return !isLocalWorkspaceTarget({
    workspacePath: target.workspacePath ?? undefined,
    workspaceIdentity: target.workspaceIdentity,
    remoteSessionId: target.remoteSessionId,
    remoteTarget: target.remoteTarget,
  });
}

export function shouldEnableWorkspaceRpc(
  target: WorkspaceRpcAvailabilityTarget,
): boolean {
  return (
    !isRemoteWorkspaceRpcTarget(target) ||
    Boolean(target.remoteSessionId?.trim())
  );
}
