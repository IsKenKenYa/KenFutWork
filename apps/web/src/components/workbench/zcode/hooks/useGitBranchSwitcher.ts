/**
 * zcode 照搬 + 宿主适配 stub：`@/hooks/useGitBranchSwitcher.ts`
 * （references/zcode/packages/ui/src/hooks/useGitBranchSwitcher.ts）
 * 许可证：Apache-2.0（zcode）。
 *
 * 数据源差异：zcode 的分支列表/切换经其 RPC gitService（getLocalBranches /
 * switchBranch / createBranchAndSwitch / stagePaths / commit）；本仓宿主 git 走
 * 自己的服务端 API（apps/web/src/lib/code-git-api.ts），不经 zcode RPC。
 * 故本 hook 按 stub 模式落地：导出签名逐字保持，分支列表恒 null、加载恒 false、
 * 一切写操作恒 no-op（不抛错、不 toast），UI 消费侧由 GitBranchSwitcher 的
 * `gitSummary.isGitAvailable && isRepository` 可见性门控整体隐藏。
 * 后续接通宿主 git API 时在此替换实现，照搬组件零改动。
 */
"use client";

import type {
  GitBranchSwitchAssistDialogStep,
  GitBranchSwitchAssistState,
} from "@zui/git-branch-switcher/switchAssist";
import type {
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zui/lib/zcode-shared";
import { useCallback, useState } from "react";

export interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  // gitSummary 是 HEAD 的真实来源(由文件 watcher 实时回灌)。传入它的当前分支/HEAD 类型，
  // 用于在底层 HEAD 变化时丢弃可能过期的本地分支快照。
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

/**
 * stub：与 zcode 同签名同返回形状；数据恒空、写操作恒 no-op。
 */
export function useGitBranchSwitcher({
  onRefreshGit: _onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [switchAssistStep, setSwitchAssistStep] =
    useState<GitBranchSwitchAssistDialogStep | null>(null);
  const [switchAssistState, setSwitchAssistState] =
    useState<GitBranchSwitchAssistState | null>(null);
  const [branchesResult, setBranchesResult] =
    useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const switchBranch = useCallback(async (_targetBranchName: string) => {
    // stub：分支切换未接通，恒 no-op。
  }, []);

  const createBranchAndSwitch = useCallback(async () => {
    // stub：创建并切换分支未接通，恒 no-op。
  }, []);

  const openSwitchCommitDialog = useCallback(() => {
    // stub：切换辅助对话框数据恒空，不打开。
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const commitAndSwitchBranch = useCallback(async () => {
    // stub：提交并切换分支未接通，恒 no-op。
  }, []);

  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}
