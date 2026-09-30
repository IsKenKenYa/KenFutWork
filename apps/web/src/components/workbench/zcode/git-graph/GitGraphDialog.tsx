/**
 * zcode 照搬 + 宿主适配 stub：`@/git-graph/GitGraphDialog.tsx`
 * （references/zcode/packages/ui/src/git-graph/GitGraphDialog.tsx）
 * 许可证：Apache-2.0（zcode）。
 *
 * 数据源差异：zcode 的提交图经其 RPC gitService.getCommitGraph 分页拉取；本仓宿主
 * git 走自己的服务端 API（apps/web/src/lib/code-git-api.ts），不经 zcode RPC。
 * 故本组件按 stub 模式落地：导出签名（props）逐字保持，渲染恒 null——UI 降级隐藏，
 * 消费方（GitBranchSwitcher 底部「查看提交图」入口）打开后呈现空对话框即整体不可见。
 * 后续接通宿主 git 提交图 API 时在此替换实现，照搬组件零改动。
 */
"use client";

export interface GitGraphDialogProps {
  open: boolean;
  workspacePath: string;
  onOpenChange: (nextOpen: boolean) => void;
}

export function GitGraphDialog({
  open: _open,
  workspacePath: _workspacePath,
  onOpenChange: _onOpenChange,
}: GitGraphDialogProps) {
  // stub：提交图未接通，恒不渲染（UI 降级隐藏）。
  return null;
}
