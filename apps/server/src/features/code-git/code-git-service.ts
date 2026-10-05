import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../execution/scope-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  GitChangedFiles,
  GitClient,
  GitDiffStat,
  GitGraph,
  GitRepoView,
} from "./git-client.js";
import { patchTargetsOnly } from "./hunk-patch.js";
import {
  listSandboxDir,
  readSandboxTextFile,
  type SandboxDirListing,
  type SandboxFileView,
} from "./sandbox-file.js";
import { collectManagedOutput } from "./scoped-git-exec.js";
import {
  detectTerminalShells,
  resolveTerminalShell,
  type TerminalResult,
  type TerminalShellId,
  type TerminalShellOption,
} from "./terminal-runner.js";

/**
 * git 分支视图服务（Code 模式）。
 *
 * **鉴权与归属校验在这里**：客户端只给 `taskId`，服务端必须先确认它属于**当前用户的
 * 工作区**（Task → 项目 → 工作区链），再读取 Task 创建时绑定的真实目录。
 * 缺少这条校验会让已知 Task id 变成跨工作区读取目录的入口。
 *
 * 目录一律经 `ExecutionScopeHandle.resolvePath` 解析——与 agent 后端**同一处**判定，保证「git 操作的分支
 * 目录」就是「agent 读写文件的目录」，不会各算各的。
 */
/** 差异文本与清单的响应上限：界面是给人看的，超出的部分截断并如实标注。 */

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

/** 目录清单（R3-1「文件目录」标签）。 */
export type CodeFileListing = SandboxDirListing;

export type CodeGitService = {
  status(user: LocalActor, taskId: string): Promise<CodeGitStatus>;
  checkout(
    user: LocalActor,
    taskId: string,
    branch: string,
  ): Promise<CodeGitStatus>;
  /** 更改统计（R2-1）：相对 HEAD 的增删行数 + 未跟踪数。 */
  diffStat(user: LocalActor, taskId: string): Promise<CodeGitDiffStat>;
  /** git 图谱（R2-1 条目 6）：只读；非仓库或还没有提交时给空图，不抛错。 */
  graph(user: LocalActor, taskId: string, limit: number): Promise<CodeGitGraph>;
  /** 变更文件清单（R3-2）：逐文件增删行数与状态；非仓库给空清单。 */
  changes(
    user: LocalActor,
    taskId: string,
    maxFiles: number,
  ): Promise<CodeGitChanges>;
  /** 单文件差异（R3-2「审查」）：未跟踪文件合成「按新增行」的视图。 */
  fileDiff(
    user: LocalActor,
    taskId: string,
    path: string,
  ): Promise<CodeGitFileDiff>;
  /** 单文件内容（R3-2「打开」/ R3-3「文档入口」）：只读、有字节上限、二进制只回元信息。 */
  readFile(
    user: LocalActor,
    taskId: string,
    path: string,
  ): Promise<CodeGitFileView>;
  /**
   * 在**该Task的工作目录**里执行用户自己敲的命令（R3-1「终端」标签）。
   * 权限口径见 `terminal-runner.ts`：这是用户操作自己的机器，不是 agent 工具调用；
   * 因此没有工具门，但同样受「登录 + Task归属 + 沙箱 cwd + 超时/输出上限」约束。
   */
  runTerminal(
    user: LocalActor,
    taskId: string,
    command: string,
    shell?: TerminalShellId,
  ): Promise<TerminalResult>;
  /**
   * 本机可用的 shell + 工作区默认（终端下拉与设置页共用）。
   * `resolvedShell` 是默认值在这台机器上实际会用的那个（`auto` 时尤其需要说清）。
   */
  listTerminalShells(user: LocalActor): Promise<{
    shells: TerminalShellOption[];
    defaultShell: TerminalShellId;
    resolvedShell: TerminalShellId;
  }>;
  /**
   * 交互式终端会话的落点：**已校验归属**的工作目录（WS 那条路用它起常驻 shell）。
   * 与一次性执行同一处解析（`ExecutionScopeHandle.resolvePath`）——会话里的命令和 agent 读写的
   * 是同一个目录。
   */
  terminalWorkDir(user: LocalActor, taskId: string): Promise<string>;
  /**
   * 索引库（R4-3）的作用域：已校验归属的工作目录 + 工作区 id（开关按工作区读）。
   * 与 terminalWorkDir 同一处解析，保证「索引里的路径」与 agent 写的是同一个目录。
   */
  indexScope(
    user: LocalActor,
    taskId: string,
  ): Promise<{ instanceId: string; dir: string }>;
  /** 列一层目录（R3-1「文件目录」标签）：只列一层，子目录由界面点进去。 */
  listFiles(
    user: LocalActor,
    taskId: string,
    path: string,
  ): Promise<CodeFileListing>;
  /** 暂存 / 取消暂存单个文件（参考图审查视图的「暂存」）。 */
  setFileStaged(
    user: LocalActor,
    taskId: string,
    path: string,
    staged: boolean,
  ): Promise<{ path: string; staged: boolean }>;
  /** 应用 / 反向应用**一个块**（参考图审查视图的「暂存块 / 撤销块」）。 */
  applyFileHunk(
    user: LocalActor,
    taskId: string,
    path: string,
    patch: string,
    options?: { reverse?: boolean; target?: "index" | "worktree" },
  ): Promise<{ path: string; applied: true }>;
  /** 撤销单个文件的改动（二次确认在界面）；未跟踪 = 删除该文件。 */
  discardFile(
    user: LocalActor,
    taskId: string,
    path: string,
    untracked: boolean,
  ): Promise<{ path: string }>;
  /** 撤销全部未提交改动（二次确认在界面）。 */
  discardAllChanges(user: LocalActor, taskId: string): Promise<{ ok: true }>;
  /** 提交全部改动（写操作：git 不可用即 503，未仓库/空改动 409）。 */
  /** 初始化仓库（幂等）。 */
  init(user: LocalActor, taskId: string): Promise<CodeGitStatus>;
  commit(
    user: LocalActor,
    taskId: string,
    message: string,
  ): Promise<CodeGitStatus>;
  /** 推送当前分支（写操作，同上纪律）。 */
  push(user: LocalActor, taskId: string): Promise<CodeGitStatus>;
  /** 创建并检出新分支（写操作，同上纪律）。 */
  createBranch(
    user: LocalActor,
    taskId: string,
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
  scopes: Pick<ExecutionScopes, "openTask">;
  gitForScope: (
    scope: ExecutionScopeHandle,
    actor: LocalActor,
  ) => Promise<GitClient>;
  processSandbox: ProcessSandbox;
  localInstance: Pick<LocalInstanceService, "resolve">;
  settingsService: Pick<SettingsService, "getInstanceSettings">;
  source: GitSource;
  availableShells?: readonly TerminalShellOption[] | undefined;
}): CodeGitService {
  const { source, localInstance } = options;
  const instanceSettings = async (user: LocalActor) => {
    const workspace = await localInstance.resolve(user);
    return options.settingsService.getInstanceSettings(
      user,
      workspace.instanceId,
    );
  };
  const workspaceShell = async (user: LocalActor): Promise<TerminalShellId> =>
    (await instanceSettings(user)).terminalShell;
  const scopeFor = async (
    user: LocalActor,
    taskId: string,
    operation: "read" | "write" = "read",
  ) => {
    const scope = await options.scopes.openTask(user, taskId);
    const dir = await scope.resolvePath(".", operation);
    const git = await options.gitForScope(scope, user);
    return { scope, dir, git, limits: scope.backend.limits };
  };

  const read = async (git: GitClient, dir: string): Promise<CodeGitStatus> => {
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

  const requireRepo = async (git: GitClient, dir: string): Promise<void> => {
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
    async status(user, taskId) {
      const { dir, git } = await scopeFor(user, taskId);
      return read(git, dir);
    },

    async checkout(user, taskId, branch) {
      const { dir, git } = await scopeFor(user, taskId, "write");
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
      return read(git, dir);
    },

    async diffStat(user, taskId) {
      const { dir, git } = await scopeFor(user, taskId);
      return git.diffStat(dir);
    },

    /**
     * 图谱是**只读视图**：非仓库、仓库还没有任何提交都返回空图 + `isRepo`
     * ——这两种情况界面各自有话说（初始化引导 / 还没有提交），抛错反而把「状态」
     * 说成「故障」。越权仍在 `scopeFor` 一轮挡住（404）。
     */
    async graph(user, taskId, limit) {
      const { dir, git } = await scopeFor(user, taskId);
      const view = await git.describe(dir);
      if (!view.isRepo) {
        return { isRepo: false, entries: [], truncated: false };
      }
      const graph = await git.graph(dir, limit);
      return { isRepo: true, ...graph };
    },

    /** 变更清单：与图谱同样「状态不是故障」——非仓库给空清单。 */
    async changes(user, taskId, maxFiles) {
      const { dir, git } = await scopeFor(user, taskId);
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
    async fileDiff(user, taskId, path) {
      const { dir, git, scope, limits } = await scopeFor(user, taskId);
      await scope.resolvePath(path, "read");
      const changes = await git.changedFiles(dir, limits.codeSearchMaxResults);
      const entry = changes.files.find((file) => file.path === path);
      if (entry?.status === "untracked") {
        const view = readSandboxTextFile(dir, path, limits.codeReadMaxBytes);
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
          text: `${view.truncated ? "…（文件过大，仅显示配置的字节上限）\n" : ""}${body}`,
          truncated: view.truncated,
          untracked: true,
        };
      }
      const text = await git.fileDiff(dir, path, limits.codeSearchMaxBytes);
      return {
        path,
        text,
        truncated: text.includes("…（已截断）"),
        untracked: false,
      };
    },

    async runTerminal(user, taskId, command, shell) {
      const trimmed = command.trim();
      if (!trimmed) {
        throw new CodeGitError("git_write_failed", "命令不能为空。", 400);
      }
      const { dir, scope } = await scopeFor(user, taskId);
      const settings = await instanceSettings(user);
      const selected = resolveTerminalShell(
        shell ?? settings.terminalShell,
        options.availableShells ?? detectTerminalShells(),
      );
      if (!selected)
        throw new CodeGitError(
          "git_unavailable",
          "所选终端 shell 不可用。",
          503,
        );
      const started = Date.now();
      const child = await options.processSandbox.spawn({
        scope: scope.describe(),
        agentId: scope.agentId,
        invocationId: randomUUID(),
        command: trimmed,
        cwd: dir,
        shell: selected.executable,
        background: false,
        timeoutMs: settings.executeTimeoutMs,
        limits: {
          maxOutputBytes: settings.processMaxOutputBytes,
          previewMaxChars: settings.processPreviewMaxChars,
          yieldMs: settings.processYieldMs,
          killGraceMs: settings.processKillGraceMs,
        },
      });
      await child.endStdin();
      const exit = await child.waitForExit();
      if (!exit.rangeEmpty)
        throw new CodeGitError("git_write_failed", "终端尚未确认退出。", 503);
      const stdout = await collectManagedOutput(
        child,
        settings.processMaxOutputBytes,
        "stdout",
      );
      const stderr = await collectManagedOutput(
        child,
        settings.processMaxOutputBytes,
        "stderr",
      );
      return {
        command: trimmed,
        shell: selected.id,
        exitCode: exit.exitCode,
        timedOut: exit.reason === "timeout",
        stdout,
        stderr,
        truncated: child.snapshot().discardedBytes > 0,
        durationMs: Date.now() - started,
      };
    },

    async listTerminalShells(user) {
      const shells = [...(options.availableShells ?? detectTerminalShells())];
      const defaultShell = (await workspaceShell(user)) ?? "auto";
      return {
        shells,
        defaultShell,
        resolvedShell: resolveTerminalShell(defaultShell, shells)?.id ?? "auto",
      };
    },

    /** 交互式会话的 cwd：与一次性执行同一处归属校验（越权即 404）。 */
    async terminalWorkDir(user, taskId) {
      return (await scopeFor(user, taskId)).dir;
    },

    /** 索引库作用域：目录 + 工作区（开关在工作区设置里）。 */
    async indexScope(user, taskId) {
      const workspace = await localInstance.resolve(user).catch(() => null);
      if (!workspace) {
        throw new CodeGitError("not_found", "找不到工作区。", 404);
      }
      const { dir } = await scopeFor(user, taskId);
      return { instanceId: workspace.instanceId, dir };
    },

    /** 暂存单个文件：路径先过「必须落在工作目录内」这道门（与读文件同一处判定）。 */
    async setFileStaged(user, taskId, path, staged) {
      const { dir, git, scope } = await scopeFor(user, taskId, "write");
      try {
        await scope.resolvePath(path, "write");
        resolveInsideRoot(dir, path);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "路径越出工作目录。",
          400,
        );
      }
      await requireRepo(git, dir);
      try {
        await git.stageFile(dir, path, staged);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "暂存失败。",
          400,
        );
      }
      return { path, staged };
    },

    /**
     * 暂存单个块：先过「路径落在工作目录内」，再**核对 patch 里改的确实只有这个文件**，
     * 最后才交给 git apply（见 hunk-patch.ts 的注释：patch 里的路径才是 git 真会动的路径）。
     */
    async applyFileHunk(user, taskId, path, patch, options = {}) {
      const { dir, git, scope, limits } = await scopeFor(user, taskId, "write");
      if (Buffer.byteLength(patch) > limits.codePatchMaxBytes)
        throw new CodeGitError(
          "git_write_failed",
          "补丁超过工作区字节预算。",
          400,
        );
      try {
        await scope.resolvePath(path, "write");
        resolveInsideRoot(dir, path);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "路径越出工作目录。",
          400,
        );
      }
      if (!patchTargetsOnly(patch, path)) {
        throw new CodeGitError(
          "git_write_failed",
          "这份补丁改的文件与请求不一致，已拒绝。",
          400,
        );
      }
      await requireRepo(git, dir);
      try {
        await git.applyHunk(dir, patch, options);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "暂存这一块失败。",
          400,
        );
      }
      return { path, applied: true };
    },

    /** 撤销单个文件：与暂存同一道门（路径在工作目录内 + 是仓库）。 */
    async discardFile(user, taskId, path, untracked) {
      const { dir, git, scope } = await scopeFor(user, taskId, "write");
      try {
        await scope.resolvePath(path, "write");
        resolveInsideRoot(dir, path);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "路径越出工作目录。",
          400,
        );
      }
      await requireRepo(git, dir);
      try {
        await git.discardFile(dir, path, untracked);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "撤销失败。",
          400,
        );
      }
      return { path };
    },

    /** 撤销全部未提交改动。 */
    async discardAllChanges(user, taskId) {
      const { dir, git } = await scopeFor(user, taskId, "write");
      await requireRepo(git, dir);
      try {
        await git.discardAll(dir);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : "撤销失败。",
          400,
        );
      }
      return { ok: true };
    },

    /** 列一层目录：路径越界/不存在/不是目录都折成 400 可读原因。 */
    async listFiles(user, taskId, path) {
      const { scope, limits } = await scopeFor(user, taskId);
      try {
        const target = await scope.resolvePath(path || ".", "read");
        const listed = listSandboxDir(target, "", limits.codeSearchMaxResults);
        await scope.resolvePath(path || ".", "read");
        return {
          ...listed,
          path,
          entries: listed.entries.map((entry) => ({
            ...entry,
            path: join(path || ".", entry.name),
          })),
        };
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          400,
        );
      }
    },

    /** 文件内容：路径越界/不存在/是目录都折成 400 的可读原因（`sendCodeGitError` 兜底 500）。 */
    async readFile(user, taskId, path) {
      const { scope, limits } = await scopeFor(user, taskId);
      try {
        const target = await scope.resolvePath(path, "read");
        const result = readSandboxTextFile(
          dirname(target),
          target.slice(dirname(target).length + 1),
          limits.codeReadMaxBytes,
        );
        if ((await scope.resolvePath(path, "read")) !== target)
          throw new Error("文件路径或授权在读取期间变化。");
        return { ...result, path };
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
    async init(user, taskId) {
      requireGitForWrite();
      const { dir, git } = await scopeFor(user, taskId, "write");
      const view = await git.describe(dir);
      if (!view.isRepo) {
        await git.init(dir);
      }
      return read(git, dir);
    },

    async commit(user, taskId, message) {
      const { dir, git } = await scopeFor(user, taskId, "write");
      requireGitForWrite();
      await requireRepo(git, dir);
      try {
        await git.commitAll(dir, message);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(git, dir);
    },

    async push(user, taskId) {
      const { dir, git } = await scopeFor(user, taskId, "write");
      requireGitForWrite();
      await requireRepo(git, dir);
      try {
        await git.push(dir);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(git, dir);
    },

    async createBranch(user, taskId, name) {
      const { dir, git } = await scopeFor(user, taskId, "write");
      requireGitForWrite();
      await requireRepo(git, dir);
      try {
        await git.createBranch(dir, name);
      } catch (error) {
        throw new CodeGitError(
          "git_write_failed",
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
      return read(git, dir);
    },
  };
}
