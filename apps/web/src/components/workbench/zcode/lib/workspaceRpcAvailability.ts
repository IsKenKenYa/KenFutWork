/**
 * zcode 照搬：`@/lib/workspaceRpcAvailability.ts`（references/zcode/packages/ui/src/lib/workspaceRpcAvailability.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）。
 */
interface WorkspaceRpcAvailabilityTarget {
  workspaceIdentity?: string | null | undefined;
  remoteSessionId?: string | null | undefined;
  remoteTarget?: unknown;
}

function isRemoteWorkspaceRpcTarget(
  target: WorkspaceRpcAvailabilityTarget,
): boolean {
  return Boolean(
    target.workspaceIdentity?.trim() ||
      target.remoteSessionId?.trim() ||
      target.remoteTarget,
  );
}

export function shouldEnableWorkspaceRpc(
  target: WorkspaceRpcAvailabilityTarget,
): boolean {
  return (
    !isRemoteWorkspaceRpcTarget(target) ||
    Boolean(target.remoteSessionId?.trim())
  );
}
