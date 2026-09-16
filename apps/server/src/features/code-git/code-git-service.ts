import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type {
  GitChangedFiles,
  GitClient,
  GitDiffStat,
  GitGraph,
  GitRepoView,
} from "./git-client.js";
import {
  existingSandboxFiles,
  readSandboxTextFile,
  type SandboxFileView,
} from "./sandbox-file.js";

/**
 * 「文档入口」（R3-3）的候选清单：约定俗成的项目文档名。
 * 顺序即展示顺序——AGENTS.md 在最前（它才是给 Agent 的规则书）。
 */
const DOC_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/README.md",
] as const;

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
/** 差异文本与清单的响应上限：界面是给人看的，超出的部分截断并如实标注。 */
const MAX_DIFF_BYTES = 400 * 1024;
const MAX_DIFF_SCAN_FILES = 500;

export type GitSource = "system" | "bundled" | "unavailable";

export interface CodeGitStatus {
  branch: GitRepoView["branch"];
  branches: GitRepoView["branches"];
  dirty: boolean;
  isRepo: boolean;
  source: GitSource;
}

export type CodeGitDiffStat = GitDiffStat;

/** 图谱视图：多一个 `isRepo`，非仓库时前端显示初始化引导而不是空图。 */
export type CodeGitGraph = GitGraph & { isRepo: boolean };

/** 变更清单（R3-2）：非仓库时给空清单，界面显示的是「不是仓库」而不是「没有改动」。 */
export type CodeGitChanges = GitChangedFiles & { isRepo: boolean };

/** 单文件差异（R3-2「审查」）。 */
export interface CodeGitFileDiff {
  path: string;
  /** 统一 diff 文本；未跟踪文件是「按新增行」的合成视图。 */
  text: string;
  truncated: boolean;
  /** 合成视图（未跟踪文件不在 `git diff HEAD` 里，是读文件内容拼的）。 */
  untracked: boolean;
}

/** 单文件内容（R3-2「打开」/ R3-3「文档入口」）。 */
export type CodeGitFileView = SandboxFileView;

export type CodeGitService = {
  status(user: AuthenticatedUser, canvasId: string): Promise<CodeGitStatus>;
  checkout(
    user: AuthenticatedUser,
    canvasId: string,
    branch: string,
  ): Promise<CodeGitStatus>;
  /** 更改统计（R2-1）：相对 HEAD 的增删行数 + 未跟踪数。 */
  diffStat(user: AuthenticatedUser, canvasId: string): Promise<CodeGitDiffStat>;
  /** git 图谱（R2-1 条目 6）：只读；非仓库或还没有提交时给空图，不抛错。 */
  graph(
    user: AuthenticatedUser,
    canvasId: string,
    limit: number,
  ): Promise<CodeGitGraph>;
  /** 变更文件清单（R3-2）：逐文件增删行数与状态；非仓库给空清单。 */
  changes(
    user: AuthenticatedUser,
    canvasId: string,
    maxFiles: number,
  ): Promise<CodeGitChanges>;
  /** 单文件差异（R3-2「审查」）：未跟踪文件合成「按新增行」的视图。 */
  fileDiff(
    user: AuthenticatedUser,
    canvasId: string,
    path: string,
  ): Promise<CodeGitFileDiff>;
  /** 单文件内容（R3-2「打开」/ R3-3「文档入口」）：只读、有字节上限、二进制只回元信息。 */
  readFile(
    user: AuthenticatedUser,
    canvasId: string,
    path: string,
  ): Promise<CodeGitFileView>;
  /** 工作目录里的项目文档（R3-3）：候选清单里存在的那些，附字节数。 */
  listDocs(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<Array<{ path: string; bytes: number }>>;
  /** 提交全部改动（写操作：git 不可用即 503，未仓库/空改动 409）。 */
  /** 初始化仓库（幂等）。 */
  init(user: AuthenticatedUser, canvasId: string): Promise<CodeGitStatus>;
  commit(
    user: AuthenticatedUser,
    canvasId: string,
    message: string,
  ): Promise<CodeGitStatus>;
  /** 推送当前分支（写操作，同上纪律）。 */
  push(user: AuthenticatedUser, canvasId: string): Promise<CodeGitStatus>;
  /** 创建并检出新分支（写操作，同上纪律）。 */
  createBranch(
    user: AuthenticatedUser,
    canvasId: string,
    name: string,
  ): Promise<CodeGitStatus>;
};

export class CodeGitError extends Error {
  readonly code:
    | "not_found"
    | "git_unavailable"
    | "checkout_failed"
    | "git_write_failed";
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
  /** 画布 → 真实目录映射（与 agent 后端同一张表，保证 git 操作的就是 agent 读写的目录）。 */
  canvasWorkDirs?: Record<string, string> | undefined;
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
    return resolveSandboxDir(
      canvasId,
      options.sandboxRoot,
      options.canvasWorkDirs?.[canvasId],
    );
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

  /** 写操作的公共前置：git 可用性（写必须真的有 git 可执行）。 */
  const requireGitForWrite = () => {
    if (source === "unavailable") {
      throw new CodeGitError(
        "git_unavailable",
        "当前环境没有可用的 git（既未装本地 git，也未随包分发）。",
        503,
      );
    }
  };

  const requireRepo = async (dir: string): Promise<void> => {
    const view = await git.describe(dir);
    if (!view.isRepo) {
      throw new CodeGitError(
        "git_write_failed",
        "该工作目录还不是 git 仓库（可先在对话里让 Agent 执行 git init）。",
        409,
      );
    }
  };

  return {
    async status(user, canvasId) {
      return read(await sandboxDirFor(user, canvasId));
    },

    async checkout(user, canvasId, branch) {
      const dir = await sandboxDirFor(user, canvasId);
      requireGitForWrite();
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

    async diffStat(user, canvasId) {
      const dir = await sandboxDirFor(user, canvasId);
      return git.diffStat(dir);
    },

    /**
     * 图谱是**只读视图**：非仓库、仓库还没有任何提交都返回空图 + `isRepo`
     * ——这两种情况界面各自有话说（初始化引导 / 还没有提交），抛错反而把「状态」
     * 说成「故障」。越权仍在 `sandboxDirFor` 一轮挡住（404）。
     */
    async graph(user, canvasId, limit) {
      const dir = await sandboxDirFor(user, canvasId);
      const view = await git.describe(dir);
      if (!view.isRepo) {
        return { isRepo: false, entries: [], truncated: false };
      }
      const graph = await git.graph(dir, limit);
      return { isRepo: true, ...graph };
    },

    /** 变更清单：与图谱同样「状态不是故障」——非仓库给空清单。 */
    async changes(user, canvasId, maxFiles) {
      const dir = await sandboxDirFor(user, canvasId);
      const view = await git.describe(dir);
      if (!view.isRepo) {
        return { isRepo: false, files: [], truncated: false };
      }
      const changes = await git.changedFiles(dir, maxFiles);
      return { isRepo: true, ...changes };
    },

    /**
     * 单文件差异。未跟踪文件走**合成视图**：`git diff HEAD` 对它们本来就是空的，
     * 直接抛「没有差异」会让用户以为文件没改过；这里改为读内容、每行前加 `+`，
     * 并在响应里标 `untracked: true`，界面上要如实写「未跟踪文件（按新增展示）」。
     */
    async fileDiff(user, canvasId, path) {
      const dir = await sandboxDirFor(user, canvasId);
      const changes = await git.changedFiles(dir, MAX_DIFF_SCAN_FILES);
      const entry = changes.files.find((file) => file.path === path);
      if (entry?.status === "untracked") {
        const view = readSandboxTextFile(dir, path);
        if (view.binary) {
          return {
            path,
            text: "（二进制文件，无法按文本显示差异）",
            truncated: false,
            untracked: true,
          };
        }
        // 文件通常以换行结尾：那个空尾元素不该被画成一行孤零零的 `+`
        const lines = view.content.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const body = lines.map((line) => `+${line}`).join("\n");
        return {
          path,
          text: `${view.truncated ? "…（文件过大，仅显示前 256 KB）\n" : ""}${body}`,
          truncated: view.truncated,
          untracked: true,
        };
      }
      const text = await git.fileDiff(dir, path, MAX_DIFF_BYTES);
      return {
        path,
        text,
        truncated: text.includes("…（已截断）"),
        untracked: false,
      };
    },

    /** 项目文档清单：只 stat 候选文件，不读内容（列表要轻）。 */
    async listDocs(user, canvasId) {
      const dir = await sandboxDirFor(user, canvasId);
      return existingSandboxFiles(dir, DOC_CANDIDATES);
    },

    /** 文件内容：路径越界/不存在/是目录都折成 400 的可读原因（`sendCodeGitError` 兜底 500）。 */
    async readFile(user, canvasId, path) {
      const dir = await sandboxDirFor(user, canvasId);
      try {
        return readSandboxTextFile(dir, path);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          400,
        );
      }
    },

    /**
     * 把工作目录初始化成仓库（「每次对话用 git 跟踪」的前置；已有仓库则无副作用）。
     * 失败时给可读原因（git 不可用 / 目录不可写）。
     */
    async init(user, canvasId) {
      requireGitForWrite();
      const dir = await sandboxDirFor(user, canvasId);
      const view = await git.describe(dir);
      if (!view.isRepo) {
        await git.init(dir);
      }
      return read(dir);
    },

    async commit(user, canvasId, message) {
      const dir = await sandboxDirFor(user, canvasId);
      requireGitForWrite();
      await requireRepo(dir);
      try {
        await git.commitAll(dir, message);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(dir);
    },

    async push(user, canvasId) {
      const dir = await sandboxDirFor(user, canvasId);
      requireGitForWrite();
      await requireRepo(dir);
      try {
        await git.push(dir);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(dir);
    },

    async createBranch(user, canvasId, name) {
      const dir = await sandboxDirFor(user, canvasId);
      requireGitForWrite();
      await requireRepo(dir);
      try {
        await git.createBranch(dir, name);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(dir);
    },
  };
}
