/**
 * zcode 照搬：`@/store/tabWorkspaceIdentity.ts`（references/zcode/packages/ui/src/store/tabWorkspaceIdentity.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）。
 */
interface WorkspaceTabIdentityLike {
  workspacePath: string;
  remoteSessionId?: string | undefined;
  workspaceIdentity?: string | undefined;
}

interface WorkspaceTabMatchOptions {
  remoteSessionId?: string | undefined;
  workspaceIdentity?: string | undefined;
}

function hasRemoteTabIdentity(tab: WorkspaceTabIdentityLike): boolean {
  return Boolean(tab.workspaceIdentity || tab.remoteSessionId);
}

function isLocalWorkspaceTab(tab: WorkspaceTabIdentityLike): boolean {
  return !hasRemoteTabIdentity(tab);
}

export function isSameWorkspaceTab(
  tab: WorkspaceTabIdentityLike,
  workspacePath: string,
  options?: WorkspaceTabMatchOptions,
): boolean {
  if (tab.workspacePath !== workspacePath) {
    return false;
  }

  if (options?.workspaceIdentity) {
    return tab.workspaceIdentity === options.workspaceIdentity;
  }

  if (options?.remoteSessionId) {
    return tab.remoteSessionId === options.remoteSessionId;
  }

  return isLocalWorkspaceTab(tab);
}
