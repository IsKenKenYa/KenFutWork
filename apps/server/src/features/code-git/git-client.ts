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
  /** 更改统计（R2-1）：相对 HEAD 的增删行数 + 未跟踪文件数。 */
  diffStat(cwd: string): Promise<GitDiffStat>;
  /** 暂存全部改动并提交；空信息或无可提交内容抛可读错误。 */
  commitAll(cwd: string, message: string): Promise<void>;
  /** 推送当前分支到其上游；无上游时给可读指引。 */
  push(cwd: string): Promise<void>;
  /** 创建并检出新分支（`switch -c`）。 */
  createBranch(cwd: string, name: string): Promise<void>;
  /** 把普通目录初始化成仓库（`git init`；已是仓库时无副作用）。 */
  init(cwd: string): Promise<void>;
  /** git 图谱（R2-1 条目 6）：最近 N 条提交的图形行。 */
  graph(cwd: string, limit: number): Promise<GitGraph>;
}

/** git 图谱（R2-1 参考图的「Git 图谱」）。 */
export interface GitGraph {
  /** 图形行（保留 `*`/`|`/`\` 等字符，交给界面用等宽字体原样渲染）。 */
  lines: string[];
  /** 顶到条数上限（更早的历史没画进来）。 */
  truncated: boolean;
}

/**
 * 由 `log --graph --oneline --decorate --all -n <limit+1>` 的输出拼图谱（纯函数）。
 *
 * 判定「一条提交」的口径：把行首的图形字符（`* | \ / 空格`）剥掉后，紧跟的是
 * 7–40 位 hex（oneline 的短 sha）。这样只数提交行，不数图形连接线。
 * 多取一条（limit+1）是为了知道「是否还有更早的历史」，多的那条从结果里去掉。
 *
 * 非零退出（仓库没有任何提交、或目录不是仓库）按「空图谱」返回——空仓库不是错误，
 * 界面显示「还没有提交」比抛错更贴事实。
 */
export function toGraph(input: {
  result: GitCommandResult;
  limit: number;
}): GitGraph {
  if (input.result.code !== 0) {
    return { lines: [], truncated: false };
  }

  const lines = input.result.stdout
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);

  const commitCount = lines.filter((line) =>
    /^[0-9a-f]{7,40}\b/.test(line.replace(/^[|\\/\s*]+/, "")),
  ).length;

  const truncated = commitCount > input.limit;
  return {
    lines: truncated ? dropOldestCommitLine(lines) : lines,
    truncated,
  };
}

/**
 * 去掉最早的那条提交及其图形行（`-n limit+1` 多取的那条）。
 *
 * 图形行是「自下而上」画的历史，所以从**末尾**往回删到第一条提交行（含）为止——
 * 只删图形线会留下悬空的连接字符。
 */
function dropOldestCommitLine(lines: string[]): string[] {
  const kept = [...lines];
  while (kept.length > 0) {
    const last = kept[kept.length - 1] ?? "";
    const isCommit = /^[0-9a-f]{7,40}\b/.test(
      last.replace(/^[|\\/\s*]+/, ""),
    );
    kept.pop();
    if (isCommit) break;
  }
  return kept;
}

/** 更改统计（R2-1 参考图「更改 +1230 -10 · 21 个文件」）。 */
export interface GitDiffStat {
  /** 有改动的文件数（含未跟踪）。 */
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
}

/**
 * 由 `diff --numstat HEAD` 与 `status --porcelain` 拼 heirloom 统计（纯函数）。
 *
 * - numstat 在仓库没有任何提交（unborn HEAD）时会非零退出——此时增删行数按 0 算，
 *   文件数仍来自 porcelain（全部算未跟踪/改动，用户能看到「有东西没提交」）。
 * - 二进制文件的 numstat 行是 `-\t-\t路径`，行数不计但文件数照算。
 */
export function toDiffStat(input: {
  numstat: GitCommandResult;
  status: GitCommandResult;
}): GitDiffStat {
  const changedLines = input.status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const untracked = changedLines.filter((line) => line.startsWith("??")).length;
  const trackedChanged = changedLines.length - untracked;

  let additions = 0;
  let deletions = 0;
  if (input.numstat.code === 0) {
    for (const line of input.numstat.stdout.split("\n")) {
      const [add = "", del = ""] = line.trim().split("\t");
      if (!add) continue;
      const addNum = Number(add);
      const delNum = Number(del);
      if (Number.isFinite(addNum)) additions += addNum;
      if (Number.isFinite(delNum)) deletions += delNum;
    }
  }

  return {
    files: trackedChanged + untracked,
    additions,
    deletions,
    untracked,
  };
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

  const diffStat = async (cwd: string): Promise<GitDiffStat> => {
    const status = await exec(["status", "--porcelain"], cwd);
    const numstat = await exec(["diff", "--numstat", "HEAD"], cwd);
    return toDiffStat({ numstat, status });
  };

  const commitAll = async (cwd: string, message: string): Promise<void> => {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("提交信息不能为空。");
    }
    const add = await exec(["add", "-A"], cwd);
    if (add.code !== 0) {
      throw new Error(add.stderr.trim() || "git add 失败。");
    }
    const commit = await exec(["commit", "-m", trimmed], cwd);
    if (commit.code !== 0) {
      const reason = commit.stderr.trim() || commit.stdout.trim();
      throw new Error(
        /nothing to commit/i.test(reason)
          ? "没有可提交的更改。"
          : reason || "git commit 失败。",
      );
    }
  };

  const push = async (cwd: string): Promise<void> => {
    const result = await exec(["push"], cwd);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        /no upstream|has no upstream/i.test(reason)
          ? "当前分支还没有上游分支，请先在终端执行一次 `git push -u`。"
          : reason || "git push 失败。",
      );
    }
  };

  const init = async (cwd: string): Promise<void> => {
    const result = await exec(["init"], cwd);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(reason || "git init 失败。");
    }
  };

  const createBranch = async (cwd: string, name: string): Promise<void> => {
    if (!isSafeBranchName(name)) {
      throw new Error(`非法分支名：${name}`);
    }
    const result = await exec(["switch", "-c", name], cwd);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        /already.*(branch|used)|already exists/i.test(reason)
          ? `分支「${name}」已存在。`
          : reason || `创建分支失败：${name}`,
      );
    }
  };

  /**
   * git 图谱：多取一条用于判断「还有更早的历史吗」（见 `toGraph`）。
   * `--no-color` 必须给——用户配置 `color.ui=always` 时图形行会夹带 ANSI 转义，
   * 渲染出来是一堆乱码方块。
   */
  const graph = async (cwd: string, limit: number): Promise<GitGraph> => {
    const result = await exec(
      [
        "log",
        "--graph",
        "--oneline",
        "--decorate",
        "--all",
        "--no-color",
        "-n",
        String(limit + 1),
      ],
      cwd,
    );
    return toGraph({ result, limit });
  };

  return {
    checkout,
    describe,
    diffStat,
    commitAll,
    push,
    createBranch,
    init,
    graph,
  };
}
