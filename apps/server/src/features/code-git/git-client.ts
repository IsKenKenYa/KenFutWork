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
  /** 变更文件清单（R3-2）：逐文件增删行数与状态。 */
  changedFiles(cwd: string, maxFiles: number): Promise<GitChangedFiles>;
  /** 单个文件的统一 diff（R3-2「审查」）。 */
  fileDiff(cwd: string, path: string, maxBytes: number): Promise<string>;
}

/** 变更清单（R3-2 参考图「24 个文件已更改 +1022 −396」的逐行形态）。 */
export interface GitChangedFiles {
  files: GitChangedFile[];
  /** 变更文件数超过上限（只列出前 maxFiles 个）。 */
  truncated: boolean;
}

export interface GitChangedFile {
  /** 相对仓库根的路径（仓库根 = 沙箱工作目录）。 */
  path: string;
  /** 新增行数；二进制文件没有行数概念，恒为 0 且 `binary=true`。 */
  additions: number;
  deletions: number;
  binary: boolean;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

/** git 图谱（参考图 `git图谱.png`：独立窗口 + 图/描述/日期/作者/提交 表格）。 */
export interface GitGraph {
  /**
   * 逐行数据。提交行与「连接线行」（只有图形字符）都在里面——图形是逐行画的，
   * 抽掉连接线会让分支图形断掉。
   */
  entries: GitGraphEntry[];
  /** 顶到条数上限（更早的历史没画进来）。 */
  truncated: boolean;
}

export interface GitGraphEntry {
  /** 该行的图形字符（`*`、`|`、`|\` 等），界面按等宽渲染成左侧的「图」列。 */
  rail: string;
  /** 提交行才有；连接线行为 null。 */
  sha: string | null;
  shortSha: string | null;
  subject: string;
  author: string;
  /** 提交时间（ISO 8601）。 */
  date: string;
  /** 该提交上的 ref 装饰（`HEAD`、`main`、`origin/main`…）。 */
  refs: string[];
  /** 父提交短 sha（详情面板的「父提交」）。 */
  parents: string[];
}

/** 字段分隔符（unit separator）：提交信息里几乎不可能出现，比分行解析稳。 */
const FIELD_SEP = "\u001f";

/**
 * 由 `log --graph --pretty=format:…` 的输出解析图谱（纯函数）。
 *
 * 每一行形如 `<图形字符>␟<sha>␟<短 sha>␟<作者>␟<日期>␟<主题>␟<refs>␟<父提交>`：
 * 按第一个 `␟` 切成「图形 + 字段」。**没有 `␟` 的行是连接线**（`|\`、`|/` 这些），
 * 保留为 rail-only 行，否则分支图形会缺笔画。
 *
 * 多取一条（`-n limit+1`）用于判断「是否还有更早的历史」；截断时丢掉**行序末尾**的
 * 那条提交（图形行不是线性的，末尾就是最旧）。
 *
 * 非零退出（仓库没有任何提交、或目录不是仓库）按「空图谱」返回——空仓库不是错误，
 * 界面显示「还没有提交」比抛错更贴事实。
 */
export function toGraph(input: {
  result: GitCommandResult;
  limit: number;
}): GitGraph {
  if (input.result.code !== 0) {
    return { entries: [], truncated: false };
  }

  const lines = input.result.stdout
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);

  const entries: GitGraphEntry[] = [];
  for (const line of lines) {
    const sepIndex = line.indexOf(FIELD_SEP);
    if (sepIndex < 0) {
      // 连接线行：只有图形字符
      entries.push({
        rail: line,
        sha: null,
        shortSha: null,
        subject: "",
        author: "",
        date: "",
        refs: [],
        parents: [],
      });
      continue;
    }
    const rail = line.slice(0, sepIndex);
    const fields = line.slice(sepIndex + 1).split(FIELD_SEP);
    entries.push({
      rail,
      sha: fields[0] ?? "",
      shortSha: fields[1] ?? "",
      author: fields[2] ?? "",
      date: fields[3] ?? "",
      subject: fields[4] ?? "",
      refs: (fields[5] ?? "")
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0),
      parents: (fields[6] ?? "").split(" ").filter((sha) => sha.length > 0),
    });
  }

  const commitCount = entries.filter((entry) => entry.sha !== null).length;
  const truncated = commitCount > input.limit;
  return {
    entries: truncated ? dropOldestCommitEntry(entries) : entries,
    truncated,
  };
}

/**
 * 由 `diff --numstat HEAD` + `status --porcelain` 拼逐文件清单（纯函数）。
 *
 * 两份输入各自只讲一半事实，必须合并：
 * - numstat 给「改了多少行」，但它**看不到未跟踪文件**（没进索引就没 diff）；
 * - porcelain 给「是什么状态」（新增/删除/重命名/未跟踪），但不给行数。
 *
 * 合并口径：以 numstat 的顺序为骨架（它就是「有内容变化的文件」），状态从 porcelain
 * 查表（查不到按修改算），再把 porcelain 里**只在未跟踪一侧出现**的文件补到末尾。
 * 二进制文件的 numstat 行是 `-\t-\t路径`——行数记 0 并打 `binary`，不要伪造数值。
 */
export function toChangedFiles(input: {
  numstat: GitCommandResult;
  status: GitCommandResult;
  maxFiles: number;
}): GitChangedFiles {
  /** porcelain 的 XY 码 → 我们的状态。`??` 是未跟踪，`R` 重命名，`A`/`D` 新增/删除。 */
  const statusByPath = new Map<string, GitChangedFile["status"]>();
  for (const line of input.status.stdout.split("\n")) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.length < 4) continue;
    const code = trimmed.slice(0, 2);
    const rest = trimmed.slice(3);
    // 重命名是 `R  old -> new`：认新路径（旧的在新提交里已经不存在）
    const path = rest.includes(" -> ")
      ? (rest.split(" -> ").pop() ?? rest)
      : rest;
    statusByPath.set(path, porcelainStatus(code));
  }

  const files: GitChangedFile[] = [];
  const seen = new Set<string>();

  if (input.numstat.code === 0) {
    for (const line of input.numstat.stdout.split("\n")) {
      const trimmed = line.replace(/\s+$/, "");
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 3) continue;
      const [add = "", del = ""] = parts;
      const rawPath = parts.slice(2).join("\t");
      const path = rawPath.includes(" => ")
        ? unfoldRenamePath(rawPath)
        : rawPath;
      seen.add(path);
      const binary = add === "-" || del === "-";
      files.push({
        path,
        additions: binary ? 0 : Number(add) || 0,
        deletions: binary ? 0 : Number(del) || 0,
        binary,
        status: statusByPath.get(path) ?? "modified",
      });
    }
  }

  // 未跟踪文件只在 porcelain 里出现：补到末尾（新增 0 行是诚实的——还没进索引，无从统计）
  for (const [path, status] of statusByPath) {
    if (seen.has(path) || status !== "untracked") continue;
    files.push({ path, additions: 0, deletions: 0, binary: false, status });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = files.length > input.maxFiles;
  return {
    files: truncated ? files.slice(0, input.maxFiles) : files,
    truncated,
  };
}

function porcelainStatus(code: string): GitChangedFile["status"] {
  const marker = code.trim();
  if (code === "??") return "untracked";
  if (marker.startsWith("R")) return "renamed";
  if (marker.startsWith("A")) return "added";
  if (marker.startsWith("D")) return "deleted";
  return "modified";
}

/**
 * numstat 里的重命名路径有两种写法：`old => new` 与 `dir/{old => new}/file`。
 * 两种都归约成**新路径**（旧路径在新提交里已经不存在）。
 */
function unfoldRenamePath(raw: string): string {
  const braced = raw.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
  if (braced) {
    return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, "/");
  }
  const parts = raw.split(" => ");
  return parts[parts.length - 1] ?? raw;
}

/**
 * 去掉最早的那条提交及其图形行（`-n limit+1` 多取的那条）。
 *
 * 图形是「自下而上」画的历史，所以从**末尾**往回删到第一条提交行（含）为止——
 * 只删图形线会留下悬空的连接字符。
 */
function dropOldestCommitEntry(entries: GitGraphEntry[]): GitGraphEntry[] {
  const kept = [...entries];
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    kept.pop();
    if (last?.sha) break;
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
  /**
   * 图谱：`--graph` 画图形，`--pretty=format:` 出结构化字段（参考图的表格要 描述/日期/作者/提交）。
   * 字段用 `%x1f`（unit separator）分隔——提交信息里几乎不可能出现，比按字符宽度切稳。
   * `--date=iso-strict` 让日期是机器可读的 ISO，界面自己决定怎么显示。
   */
  const graph = async (cwd: string, limit: number): Promise<GitGraph> => {
    const format = [
      "%H",
      "%h",
      "%an",
      "%aI",
      "%s",
      "%D",
      "%P",
    ].join("%x1f");
    const result = await exec(
      [
        "log",
        "--graph",
        `--pretty=format:%x1f${format}`,
        "--all",
        "--no-color",
        "--date=iso-strict",
        "-n",
        String(limit + 1),
      ],
      cwd,
    );
    return toGraph({ result, limit });
  };

  const changedFiles = async (
    cwd: string,
    maxFiles: number,
  ): Promise<GitChangedFiles> => {
    const status = await exec(["status", "--porcelain"], cwd);
    const numstat = await exec(["diff", "--numstat", "HEAD"], cwd);
    return toChangedFiles({ numstat, status, maxFiles });
  };

  /**
   * 单文件统一 diff。未跟踪文件在 `git diff HEAD` 里是**空的**（没进索引），
   * 故显式报错让上层去走「按新增文件读内容」那条路，而不是给用户一片空白。
   */
  const fileDiff = async (
    cwd: string,
    path: string,
    maxBytes: number,
  ): Promise<string> => {
    const result = await exec(["diff", "--no-color", "HEAD", "--", path], cwd);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(reason || `读取 ${path} 的差异失败。`);
    }
    const text = result.stdout;
    if (!text.trim()) {
      throw new Error(
        `${path} 没有可显示的差异（未跟踪文件请用「打开」查看内容）。`,
      );
    }
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n…（已截断）` : text;
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
    changedFiles,
    fileDiff,
  };
}
