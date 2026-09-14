/**
 * Git 能力（Code 模式「工作目录=项目」的分支视图）。
 *
 * 职责边界：本文件只做「git 命令 → 结构化视图」的纯逻辑，**不认识 PATH、不碰鉴权**——
 * 谁来执行命令由注入的 `exec` 决定（生产是打包/本地 git 二选一，测试是替身）。
 *
 * 安全前提：调用方必须传入**已校验归属**的沙箱目录（画布 → 项目 → 工作区），本模块
 * 不做路径校验。分支名一律先过 `isSafeBranchName` 再下发，杜绝把用户输入当参数注入。
 */

export interface GitBranchView {
  name: string;
  current: boolean;
}

export interface GitRepoView {
  isRepo: boolean;
  /** 当前分支（detached 时为 null）。 */
  branch: string | null;
  /** 本地分支（按名称排序）。 */
  branches: GitBranchView[];
  /** 有未提交改动——切分支前要提示，避免用户以为文件丢了。 */
  dirty: boolean;
}

export interface GitCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

/** 执行 git：`args` 已定稿，`cwd` 为沙箱目录。 */
export type ExecGit = (
  args: readonly string[],
  cwd: string,
) => Promise<GitCommandResult>;

/**
 * 分支名白名单：git 的 ref 名字符虽宽，但**以 `-` 开头会被当成选项**（参数注入面）。
 * 故这里只放行常规字符并显式拒绝前导 `-`。
 */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.startsWith("-")) return false;
  if (name.length > 200) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/** 解析 `git branch --format=%(refname:short)%00%(HEAD)` 的输出（NUL 分隔）。 */
export function parseBranchList(stdout: string): GitBranchView[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = "", head = ""] = line.split("\u0000");
      // git 的分支名不允许含空格，故这里裁掉两侧空白是安全的（比原样透出更稳）
      return { name: name.trim(), current: head.trim() === "*" };
    })
    .filter((branch) => branch.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 由各命令结果拼出仓库视图（纯函数，便于测试）。 */
export function toRepoView(input: {
  branchList: GitCommandResult;
  isRepo: GitCommandResult;
  status: GitCommandResult;
}): GitRepoView {
  const isRepo =
    input.isRepo.code === 0 && input.isRepo.stdout.trim() === "true";
  if (!isRepo) {
    return { isRepo: false, branch: null, branches: [], dirty: false };
  }
  const branches = parseBranchList(input.branchList.stdout);
  return {
    isRepo: true,
    branch: branches.find((branch) => branch.current)?.name ?? null,
    branches,
    // porcelain 输出为空 = 干净；命令失败时保守当作「可能有改动」
    dirty: input.status.code !== 0 || input.status.stdout.trim().length > 0,
  };
}

export interface GitClient {
  /** 仓库视图：是否仓库、当前分支、本地分支、是否脏。 */
  describe(cwd: string): Promise<GitRepoView>;
  /** 切分支；名字非法或 git 报错都抛可读错误。 */
  checkout(cwd: string, branch: string): Promise<void>;
}

export function createGitClient(deps: { exec: ExecGit }): GitClient {
  const { exec } = deps;

  const describe = async (cwd: string): Promise<GitRepoView> => {
    const isRepo = await exec(["rev-parse", "--is-inside-work-tree"], cwd);
    const branchList = await exec(
      ["branch", "--format=%(refname:short)%00%(HEAD)"],
      cwd,
    );
    const status = await exec(["status", "--porcelain"], cwd);
    return toRepoView({ branchList, isRepo, status });
  };

  const checkout = async (cwd: string, branch: string): Promise<void> => {
    if (!isSafeBranchName(branch)) {
      throw new Error(`非法分支名：${branch}`);
    }
    // 用 switch（语义比 checkout 窄：只切分支，不会顺手把路径 checkout 出来）
    const result = await exec(["switch", branch], cwd);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(reason || `切换分支失败：${branch}`);
    }
  };

  return { checkout, describe };
}
