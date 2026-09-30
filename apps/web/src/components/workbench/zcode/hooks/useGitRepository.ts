/**
 * zcode 照搬 + 宿主适配 stub：`@/hooks/useGitRepository.ts`
 * （references/zcode/packages/ui/src/hooks/useGitRepository.ts）
 * 许可证：Apache-2.0（zcode）。
 *
 * 数据源差异：zcode 的 git 状态经其 RPC gitService（refresh）+ 文件 watcher 实时回灌；
 * 本仓宿主 git 数据走自己的服务端 API（apps/web/src/lib/code-git-api.ts），不经 zcode RPC。
 * 故本文件按 stub 模式落地：导出类型逐字照搬（消费方 GitPaneChangeCard 以类型位消费
 * `GitPaneFileChange`），hook 保持导出签名但数据恒为「非仓库空态」——
 * summary.isGitAvailable/isRepository 恒 false，全部数据集恒空，UI 按 zcode 既有降级路径隐藏。
 * 后续接通宿主 git API 时在此替换实现，照搬组件零改动。
 */
"use client";

import type {
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@zui/lib/zcode-shared";
import { useMemo } from "react";

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

export interface GitPaneDataset {
  id: GitChangeSourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  turnIndex?: number | null;
}

export interface GitPaneSourceOption {
  id: GitChangeSourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitChangeSourceId, GitPaneDataset>;
}

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(
  id: GitChangeSourceId,
  readonly: boolean,
): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitChangeSourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
    "last-turn": createEmptyDataset("last-turn", true),
  };
}

function createInitialState(
  workspacePath: string,
  workspaceKey: string,
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: false,
    error: null,
    revision: 0,
    sourceOptions: [
      { id: "unstaged", count: 0, readonly: false, disabled: false },
      { id: "staged", count: 0, readonly: false, disabled: false },
      {
        id: "branch",
        count: 0,
        readonly: true,
        disabled: false,
        comparisonLabel: null,
      },
      { id: "last-turn", count: 0, readonly: true, disabled: false },
    ],
    datasets,
  };
}

/**
 * stub：与 zcode 同签名；数据恒为「非仓库空态」，不发起任何请求。
 * 消费方（GitPane 系列）按 `summary.isGitAvailable && summary.isRepository` 判定可见性，
 * 空态下 Git 面板整体隐藏——与 zcode 断连 workspace 的既有降级路径一致。
 */
export function useGitRepository(options: {
  workspacePath: string;
  activeTaskId: string | null;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const { workspacePath, workspaceIdentity = null } = options;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return useMemo(
    () => createInitialState(workspacePath, workspaceKey),
    [workspaceKey, workspacePath],
  );
}
