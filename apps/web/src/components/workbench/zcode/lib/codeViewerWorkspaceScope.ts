/**
 * zcode 照搬：`@/lib/codeViewerWorkspaceScope.ts`（references/zcode/packages/ui/src/lib/codeViewerWorkspaceScope.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
export interface CodeViewerWorkspaceScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}
