import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { GitClient, GitRepoView } from "./git-client.js";

/**
 * git 分支视图服务（Code 模式）。
 *
 * **鉴权与归属校验在这里**：客户端只给 `canvasId`，服务端必须先确认它属于**当前用户的
 * 工作区**（画布 → 项目 → 工作区链），再据此算沙箱目录。否则任何登录用户凭一个 uuid 就能
 * 读别人的沙箱仓库状态（沙箱目录名就是画布 id，属可枚举面）。缺了这条校验就是越权。
 *
 * 目录一律经 `resolveSandboxDir` 解析——与 agent 后端**同一处**判定，保证「git 操作的分支
 * 目录」就是「agent 读写文件的目录」，不会各算各的。
 */
export type GitSource = "system" | "bundled" | "unavailable";

export interface CodeGitStatus {
  branch: GitRepoView["branch"];
  branches: GitRepoView["branches"];
  dirty: boolean;
  isRepo: boolean;
  source: GitSource;
}

export type CodeGitService = {
  status(user: AuthenticatedUser, canvasId: string): Promise<CodeGitStatus>;
  checkout(
    user: AuthenticatedUser,
    canvasId: string,
    branch: string,
  ): Promise<CodeGitStatus>;
};

export class CodeGitError extends Error {
  readonly code: "not_found" | "git_unavailable" | "checkout_failed";
  readonly statusCode: number;

  constructor(code: CodeGitError["code"], message: string, statusCode: number) {
    super(message);
    this.name = "CodeGitError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createCodeGitService(options: {
  viewerService: Pick<ViewerService, "resolveWorkspace">;
  canvasRepository: Pick<CanvasRepository, "findById">;
  /** 已解析好的 git 客户端；`source` 用于界面说明来源。 */
  git: GitClient;
  source: GitSource;
  sandboxRoot?: string | undefined;
}): CodeGitService {
  const { canvasRepository, git, source, viewerService } = options;

  /**
   * canvasId → 已校验归属的沙箱目录。不可见即 404（不区分「不存在」与「不属于你」，
   * 不给账号/资源枚举留信号）。
   */
  const sandboxDirFor = async (user: AuthenticatedUser, canvasId: string) => {
    const workspace = await viewerService
      .resolveWorkspace(user)
      .catch(() => null);
    if (!workspace) {
      throw new CodeGitError("not_found", "工作区不可用。", 404);
    }
    const canvas = await canvasRepository
      .findById(workspace.id, canvasId)
      .catch(() => null);
    if (!canvas) {
      throw new CodeGitError(
        "not_found",
        "画布不存在或不属于当前工作区。",
        404,
      );
    }
    return resolveSandboxDir(canvasId, options.sandboxRoot);
  };

  const read = async (dir: string): Promise<CodeGitStatus> => {
    const view = await git.describe(dir);
    return {
      branch: view.branch,
      branches: view.branches,
      dirty: view.dirty,
      isRepo: view.isRepo,
      source,
    };
  };

  return {
    async status(user, canvasId) {
      return read(await sandboxDirFor(user, canvasId));
    },

    async checkout(user, canvasId, branch) {
      const dir = await sandboxDirFor(user, canvasId);
      if (source === "unavailable") {
        throw new CodeGitError(
          "git_unavailable",
          "当前环境没有可用的 git（既未装本地 git，也未随包分发）。",
          503,
        );
      }
      try {
        await git.checkout(dir, branch);
      } catch (error) {
        throw new CodeGitError(
          "checkout_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(dir);
    },
  };
}
