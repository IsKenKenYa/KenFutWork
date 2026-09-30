/**
 * zcode 照搬：`@/git-branch-switcher/switchAssist.ts`（references/zcode/packages/ui/src/git-branch-switcher/switchAssist.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；
 *           IGitService 来自本仓 lib/zcode-services 宿主切片类型（@zcode/services 不照搬）。
 */

import {
  buildGitBranchCommitPreviewFiles,
  type GitBranchCommitPreviewFile,
  getGitBranchCommitTotals,
  getPrimaryGitBranchIssue,
  isGitBranchCommitAssistIssue,
  selectGitBranchAffectedFiles,
} from "@zui/git-branch-switcher/display";
import { getErrorMessage } from "@zui/lib/errorMessage";
import type { IGitService } from "@zui/lib/zcode-services";
import type {
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitIdentity,
} from "@zui/lib/zcode-shared";
import { logger } from "@zui/logger";

export type GitBranchSwitchAssistDialogStep = "blocked" | "commit";

export interface GitBranchSwitchAssistState {
  targetBranchName: string;
  currentBranchName: string | null;
  issue: GitBranchMutationIssue;
  affectedFiles: GitBranchCommitPreviewFile[];
  commitFiles: GitBranchCommitPreviewFile[];
  stagePaths: string[];
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  identity: GitIdentity | null;
}

export function formatGitBranchIssuePathList(
  locale: string,
  paths: readonly string[],
): string {
  if (paths.length === 0) {
    return "";
  }

  return new Intl.ListFormat(locale, {
    style: "short",
    type: "conjunction",
  }).format(paths);
}

export function hasGitCommitIdentity(identity: GitIdentity | null): boolean {
  return (
    identity === null ||
    (Boolean(identity.userName) && Boolean(identity.userEmail))
  );
}

export async function buildGitBranchSwitchAssistState(options: {
  gitService: IGitService;
  workspacePath: string;
  result: GitBranchMutationResult;
}): Promise<GitBranchSwitchAssistState | null> {
  const issue = getPrimaryGitBranchIssue(options.result.issues);
  if (
    !issue ||
    !isGitBranchCommitAssistIssue(issue.code) ||
    !options.result.branchName
  ) {
    return null;
  }

  const [unstagedChangesResult, stagedChangesResult, identityResult] =
    await Promise.allSettled([
      options.gitService.getChanges({
        workspacePath: options.workspacePath,
        sourceId: "unstaged",
      }),
      options.gitService.getChanges({
        workspacePath: options.workspacePath,
        sourceId: "staged",
      }),
      options.gitService.getIdentity({ workspacePath: options.workspacePath }),
    ]);

  if (unstagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 unstaged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(unstagedChangesResult.reason),
    });
  }
  if (stagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 staged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(stagedChangesResult.reason),
    });
  }
  if (identityResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取提交身份失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(identityResult.reason),
    });
  }

  const unstagedChanges =
    unstagedChangesResult.status === "fulfilled"
      ? unstagedChangesResult.value
      : [];
  const stagedChanges =
    stagedChangesResult.status === "fulfilled" ? stagedChangesResult.value : [];
  const commitFiles = buildGitBranchCommitPreviewFiles([
    ...unstagedChanges,
    ...stagedChanges,
  ]);
  const affectedFiles = selectGitBranchAffectedFiles({
    files: commitFiles,
    issuePaths: issue.paths,
  });
  const stagePaths = Array.from(
    new Set([
      ...commitFiles.map((file) => file.stagePath),
      ...(issue.paths ?? []),
    ]),
  );
  const { fileCount, totalAdded, totalRemoved } =
    getGitBranchCommitTotals(commitFiles);

  return {
    targetBranchName: options.result.branchName,
    currentBranchName: options.result.summary.branchName,
    issue,
    affectedFiles,
    commitFiles,
    stagePaths,
    fileCount,
    totalAdded,
    totalRemoved,
    identity:
      identityResult.status === "fulfilled" ? identityResult.value : null,
  };
}
