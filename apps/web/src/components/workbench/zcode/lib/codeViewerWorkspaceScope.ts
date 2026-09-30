/**
 * zcode 照搬：`@/lib/codeViewerWorkspaceScope.ts`（references/zcode/packages/ui/src/lib/codeViewerWorkspaceScope.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
export interface CodeViewerWorkspaceScope {
  workspacePath?: string | undefined;
  workspaceIdentity?: string | undefined;
  workspaceRemoteSessionId?: string | undefined;
}
/* 适配注记（P9）：接口可选属性放宽 | undefined（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。 */
