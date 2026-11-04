import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { InstanceSettings } from "@kenfutwork/shared";
import type {
  GitBranchComparison,
  GitBranchMutationAction,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitCommitGraphRef,
  GitCommitGraphResult,
  GitCommitResult,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitLocalBranchListResult,
  GitPushResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { createTwoFilesPatch } from "diff";
import type { ExecGit, GitCommandResult } from "../code-git/git-client.js";

export interface CodeUiHostGitSession {
  rootDirectory: string;
  available: boolean;
  exec: ExecGit;
  resolvePath(path: string, operation: "read" | "write"): Promise<string>;
  limits: Pick<
    InstanceSettings,
    "codeReadMaxBytes" | "codeSearchMaxBytes" | "codeSearchMaxResults"
  >;
}
function requireSuccess(result: GitCommandResult): string {
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Git操作失败。");
  return result.stdout;
}
function slash(path: string) {
  return path.split(sep).join("/");
}
function parseNumstat(text: string) {
  const fields = text.split("\0");
  const stats = new Map<
    string,
    { added: number; removed: number; binary: boolean }
  >();
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (!entry) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
    if (!match) throw new Error("Git行数统计格式无效。");
    let path = match[3] ?? "";
    if (!path) {
      index++;
      path = fields[++index] ?? "";
    }
    if (!path) throw new Error("Git行数统计缺少路径。");
    stats.set(path, {
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
      binary: match[1] === "-" || match[2] === "-",
    });
  }
  return stats;
}
function parseStatus(text: string) {
  const fields = text.split("\0");
  const entries: Array<{
    path: string;
    originalPath: string | null;
    x: string;
    y: string;
  }> = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ")
      throw new Error("Git状态格式无效。");
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const path = entry.slice(3);
    let originalPath: string | null = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      originalPath = fields[++index] ?? null;
      if (originalPath === null) throw new Error("Git重命名状态缺少原路径。");
    }
    entries.push({ path, originalPath, x, y });
  }
  return entries;
}
function graphRefs(decorations: string): GitCommitGraphRef[] {
  const refs: GitCommitGraphRef[] = [];
  for (let name of decorations.split(", ").filter(Boolean)) {
    if (name === "HEAD" || name.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", kind: "head" });
      if (name === "HEAD") continue;
      name = name.slice("HEAD -> ".length);
    }
    name = name.replace(/^tag: /, "");
    const prefix = ["refs/heads/", "refs/remotes/", "refs/tags/"].find(
      (value) => name.startsWith(value),
    );
    if (!prefix) continue;
    refs.push({
      name: name.slice(prefix.length),
      kind:
        prefix === "refs/remotes/"
          ? "remote"
          : prefix === "refs/tags/"
            ? "tag"
            : "branch",
    });
  }
  return refs;
}

const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
] as const;

function literalPath(path: string) {
  return `:(literal)${path}`;
}

function branchMutationIssues(
  action: GitBranchMutationAction,
  branchName: string,
  result: GitCommandResult,
): GitBranchMutationIssue[] {
  const text = result.stderr.trim() || result.stdout.trim();
  const tracked: string[] = [];
  const untracked: string[] = [];
  let section: "tracked" | "untracked" | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (
      /local changes to the following files would be overwritten/i.test(line)
    ) {
      section = "tracked";
      continue;
    }
    if (/untracked working tree files.*would be overwritten/i.test(line)) {
      section = "untracked";
      continue;
    }
    if (section && /^\s+\S/.test(line)) {
      (section === "tracked" ? tracked : untracked).push(line.trim());
      continue;
    }
    if (line.trim()) section = null;
  }
  const issues: GitBranchMutationIssue[] = [];
  if (tracked.length)
    issues.push({
      code: "tracked-changes-would-be-overwritten",
      message: `本地修改会被覆盖，请先处理：${tracked.join("、")}`,
      paths: tracked,
    });
  if (untracked.length)
    issues.push({
      code: "untracked-changes-would-be-overwritten",
      message: `未跟踪文件会被覆盖，请先处理：${untracked.join("、")}`,
      paths: untracked,
    });
  if (/already exists/i.test(text))
    issues.push({
      code: "branch-already-exists",
      message: `分支“${branchName}”已经存在。`,
    });
  else if (
    /invalid reference|not a valid object name|no such branch/i.test(text)
  )
    issues.push({
      code: "target-branch-not-found",
      message: `找不到分支“${branchName}”。`,
    });
  else if (/is already used by worktree at/i.test(text))
    issues.push({
      code: "branch-in-other-worktree",
      message: `分支“${branchName}”正被其它工作树使用。`,
    });
  else if (
    /resolve your current index first|you have not concluded your merge|cannot switch branch while|rebase in progress/i.test(
      text,
    )
  )
    issues.push({
      code: "operation-in-progress",
      message: "仓库正在合并或变基，请先完成当前操作。",
    });
  if (!issues.length)
    issues.push({
      code: "unknown",
      message: text || `${action === "switch" ? "切换" : "创建"}分支失败。`,
      detail: text || null,
    });
  return issues;
}

function commitFailure(result: GitCommandResult) {
  const reason = result.stderr.trim() || result.stdout.trim();
  return /nothing to commit|no changes added to commit|修改尚未加入提交|没有要提交的/i.test(
    reason,
  )
    ? "没有可提交的更改。"
    : reason || "Git提交失败。";
}

/** 原IGitService的DTO投影；exec来自所属Task或Project的真实ProcessSandbox。 */
export class CodeUiHostGitRepository {
  constructor(readonly session: CodeUiHostGitSession) {}
  run(
    args: readonly string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    if (!this.session.available) throw new Error("当前环境没有可用Git。");
    return this.session.exec(args, this.session.rootDirectory, input, env);
  }
  private runAt(
    cwd: string,
    args: readonly string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    if (!this.session.available) throw new Error("当前环境没有可用Git。");
    return this.session.exec(args, cwd, input, env);
  }
  async command(
    args: readonly string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    return requireSuccess(await this.run(args, input, env));
  }
  private async commandAt(
    cwd: string,
    args: readonly string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    return requireSuccess(await this.runAt(cwd, args, input, env));
  }
  async optional(args: readonly string[]) {
    const result = await this.run(args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  async repositoryRoot() {
    const root = await this.optional(["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error("当前目录不是Git仓库。");
    return this.session.resolvePath(root, "read");
  }
  async paths(paths: string[], operation: "read" | "write") {
    const root = await this.repositoryRoot();
    const result: string[] = [];
    for (const path of paths) {
      if (!path || path.includes("\0"))
        throw new Error("Git文件路径不能为空或包含NUL。");
      const requested = isAbsolute(path)
        ? path
        : join(this.session.rootDirectory, path);
      const canonical = await this.session.resolvePath(requested, operation);
      const tail = relative(root, canonical);
      if (isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`))
        throw new Error("Git路径越出仓库根。");
      result.push(slash(tail));
    }
    if (result.length > this.session.limits.codeSearchMaxResults)
      throw new Error("Git路径数量超过工作区治理上限。");
    return result;
  }
  async ignoredPaths(paths: string[]): Promise<string[]> {
    if (paths.length > this.session.limits.codeSearchMaxResults)
      throw new Error("Git路径数量超过工作区治理上限。");
    const authorized: Array<{ original: string; absolute: string }> = [];
    for (const path of paths) {
      if (!path || path.includes("\0"))
        throw new Error("Git文件路径不能为空或包含NUL。");
      const absolute = isAbsolute(path)
        ? path
        : join(this.session.rootDirectory, path);
      await this.session.resolvePath(absolute, "read");
      authorized.push({ original: path, absolute });
    }
    if (!authorized.length) return [];
    const summary = await this.summary();
    if (!summary.isRepository) return [];
    const entries = authorized.flatMap((entry) => {
      // 保留仓库内链接名称；已授权但属于其它目录的文件不应用本仓库的忽略规则。
      const tail = relative(summary.repoRoot, entry.absolute);
      return isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`)
        ? []
        : [{ ...entry, relative: slash(tail) }];
    });
    if (!entries.length) return [];
    const result = await this.run(
      ["check-ignore", "-z", "--stdin"],
      `${entries.map((entry) => entry.relative).join("\0")}\0`,
    );
    if (result.code !== 0 && result.code !== 1)
      throw new Error(result.stderr || "Git ignore查询失败。");
    const ignored = new Set(result.stdout.split("\0").filter(Boolean));
    return entries
      .filter((entry) => ignored.has(entry.relative))
      .map((entry) => entry.original);
  }
  async summary(): Promise<GitRepositorySummary> {
    const empty: GitRepositorySummary = {
      workspacePath: this.session.rootDirectory,
      repoRoot: this.session.rootDirectory,
      workspaceInRepoPath: "",
      autoRefreshWatchPaths: [],
      branchName: null,
      trackingBranchName: null,
      headRefType: "detached",
      ahead: 0,
      behind: 0,
      isDirty: false,
      isGitAvailable: this.session.available,
      isRepository: false,
    };
    if (!this.session.available) return empty;
    const repoRoot = await this.optional(["rev-parse", "--show-toplevel"]);
    if (!repoRoot) return empty;
    await this.session.resolvePath(repoRoot, "read");
    const branchName = await this.optional([
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const trackingBranchName = await this.optional([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const comparison = trackingBranchName
      ? await this.optional([
          "rev-list",
          "--left-right",
          "--count",
          "HEAD...@{upstream}",
        ])
      : null;
    const [ahead = "0", behind = "0"] = comparison?.split(/\s+/) ?? [];
    const gitDir = await this.optional(["rev-parse", "--absolute-git-dir"]);
    const watchPaths: GitRepositorySummary["autoRefreshWatchPaths"] = [];
    if (gitDir) {
      const canonical = await this.session
        .resolvePath(gitDir, "read")
        .catch(() => null);
      if (canonical) watchPaths.push({ path: canonical, recursive: true });
    }
    return {
      ...empty,
      repoRoot,
      workspaceInRepoPath: slash(
        relative(repoRoot, this.session.rootDirectory),
      ),
      autoRefreshWatchPaths: watchPaths,
      branchName,
      trackingBranchName,
      headRefType: branchName ? "branch" : "detached",
      ahead: Number(ahead),
      behind: Number(behind),
      isDirty:
        (
          await this.command([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ])
        ).length > 0,
      isRepository: true,
    };
  }
  async localBranches(): Promise<GitLocalBranchListResult> {
    const summary = await this.summary();
    if (!summary.isRepository)
      return {
        headRefType: summary.headRefType,
        currentBranchName: null,
        branches: [],
      };
    const output = await this.command([
      "for-each-ref",
      "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
      "refs/heads/",
    ]);
    const branches = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", current, upstream, hash, date] = line.split("\0");
        return {
          name,
          isCurrent: current === "*",
          upstreamName: upstream || null,
          commitHash: hash || null,
          commitTimestampMs: date ? Number(date) * 1000 : null,
        };
      });
    return {
      headRefType: summary.headRefType,
      currentBranchName: summary.branchName,
      branches,
    };
  }
  async changes(sourceId: "staged" | "unstaged"): Promise<GitFileChange[]> {
    const summary = await this.summary();
    if (!summary.isRepository) return [];
    const stats = parseNumstat(
      await this.command([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        ...(sourceId === "staged" ? ["--cached"] : []),
      ]),
    );
    const status = parseStatus(
      await this.command([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    );
    if (status.length > this.session.limits.codeSearchMaxResults)
      throw new Error("Git变更数量超过工作区治理上限。");
    const changes: GitFileChange[] = [];
    for (const entry of status) {
      const untracked = entry.x === "?" && entry.y === "?";
      const conflict =
        entry.x === "U" ||
        entry.y === "U" ||
        ["AA", "DD"].includes(entry.x + entry.y);
      const code = sourceId === "staged" ? entry.x : entry.y;
      if (
        sourceId === "staged"
          ? untracked || conflict || code === " " || code === "?"
          : !untracked && code === " "
      )
        continue;
      const path = join(summary.repoRoot, entry.path);
      await this.session.resolvePath(path, "read");
      let count = stats.get(entry.path);
      if (untracked) {
        const text = await this.worktreeText(path);
        // 原服务不把空文件/不可预览资源的假+0统计塞进Review列表。
        if (!text.content || text.binary || text.truncated) continue;
        count = {
          added:
            text.content.split("\n").length -
            (text.content.endsWith("\n") ? 1 : 0),
          removed: 0,
          binary: false,
        };
      }
      changes.push({
        path,
        repoRelativePath: entry.path,
        workspaceRelativePath: slash(
          relative(this.session.rootDirectory, path),
        ),
        x: entry.x,
        y: entry.y,
        kind:
          code === "A" || untracked
            ? "added"
            : code === "D"
              ? "deleted"
              : code === "R"
                ? "renamed"
                : "modified",
        section: conflict ? "conflicted" : untracked ? "untracked" : sourceId,
        added: count?.added ?? 0,
        removed: count?.removed ?? 0,
        isStaged: sourceId === "staged" && !conflict,
        isUntracked: untracked,
        isConflicted: conflict,
      });
    }
    return changes;
  }
  async identity(): Promise<GitIdentity> {
    const parse = async (key: string) => {
      const output = await this.optional([
        "config",
        "--show-origin",
        "--get",
        key,
      ]);
      if (!output) return { value: null, source: null };
      const tab = output.indexOf("\t");
      return tab < 0
        ? { value: output, source: null }
        : { source: output.slice(0, tab), value: output.slice(tab + 1) };
    };
    const name = await parse("user.name");
    const email = await parse("user.email");
    return {
      userName: name.value,
      userEmail: email.value,
      nameSource: name.source,
      emailSource: email.source,
    };
  }
  /** 写操作以仓库根为 cwd，路径统一为仓库相对路径。 */
  private async writeRoot() {
    const root = await this.repositoryRoot();
    return this.session.resolvePath(root, "write");
  }
  private async writeTargets(paths: string[]) {
    return this.paths(paths, "write");
  }
  private async mutationFailure(
    action: GitBranchMutationAction,
    branchName: string | null,
    summary: GitRepositorySummary,
    issues: GitBranchMutationIssue[],
  ): Promise<GitBranchMutationResult> {
    return {
      ok: false,
      action,
      branchName,
      didChange: false,
      created: false,
      summary,
      issues,
    };
  }
  private async hasConflicts() {
    const entries = parseStatus(
      await this.command([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    );
    return entries.some(
      (entry) =>
        entry.x === "U" ||
        entry.y === "U" ||
        (entry.x === "A" && entry.y === "A") ||
        (entry.x === "D" && entry.y === "D"),
    );
  }
  private async operationInProgress() {
    for (const marker of OPERATION_MARKERS) {
      const path = await this.optional(["rev-parse", "--git-path", marker]);
      if (!path) continue;
      const absolute = isAbsolute(path)
        ? path
        : join(this.session.rootDirectory, path);
      if (
        await access(absolute).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  }
  private async validBranchName(name: string) {
    return (await this.run(["check-ref-format", "--branch", name])).code === 0;
  }
  private async branchExists(name: string) {
    return Boolean(
      await this.optional(["rev-parse", "--verify", `refs/heads/${name}`]),
    );
  }
  private async branchCheckedOutElsewhere(name: string) {
    const result = await this.run(["worktree", "list", "--porcelain"]);
    if (result.code !== 0) return false;
    return result.stdout.split(/\r?\n/).includes(`branch refs/heads/${name}`);
  }
  async stagePaths(paths: string[]): Promise<void> {
    const targets = await this.writeTargets(paths);
    if (!targets.length) return;
    await this.commandAt(await this.writeRoot(), [
      "add",
      "--",
      ...targets.map(literalPath),
    ]);
  }
  async unstagePaths(paths: string[]): Promise<void> {
    const targets = await this.writeTargets(paths);
    if (!targets.length) return;
    await this.commandAt(await this.writeRoot(), [
      "restore",
      "--staged",
      "--",
      ...targets.map(literalPath),
    ]);
  }
  async discardPaths(paths: string[], staged: boolean): Promise<void> {
    const targets = await this.writeTargets(paths);
    if (!targets.length) return;
    const root = await this.writeRoot();
    const specs = targets.map(literalPath);
    const cached = (
      await this.commandAt(root, [
        "ls-files",
        "--cached",
        "--full-name",
        "-z",
        "--",
        ...specs,
      ])
    )
      .split("\0")
      .filter(Boolean);
    const others = (
      await this.commandAt(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
        "--",
        ...specs,
      ])
    )
      .split("\0")
      .filter(Boolean);
    const under = (list: string[], target: string) =>
      list.some((entry) => entry === target || entry.startsWith(`${target}/`));
    const restoreTargets = targets.filter((target) => under(cached, target));
    const cleanTargets = targets.filter((target) => under(others, target));
    if (restoreTargets.length)
      await this.commandAt(
        root,
        staged
          ? [
              "restore",
              "--source=HEAD",
              "--staged",
              "--worktree",
              "--",
              ...restoreTargets.map(literalPath),
            ]
          : ["restore", "--worktree", "--", ...restoreTargets.map(literalPath)],
      );
    if (cleanTargets.length)
      await this.commandAt(root, [
        "clean",
        "-f",
        "-d",
        "--",
        ...cleanTargets.map(literalPath),
      ]);
  }
  private async commitStagedOnly(
    root: string,
    message: string,
    targets: string[],
  ) {
    const gitDir = (
      await this.commandAt(root, ["rev-parse", "--absolute-git-dir"])
    ).trim();
    const canonicalGitDir = await this.session.resolvePath(gitDir, "write");
    const indexFile = join(canonicalGitDir, `kenfutwork-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      const status = parseStatus(
        await this.commandAt(root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--",
          ...targets.map(literalPath),
        ]),
      );
      const cleanup = new Set<string>(targets);
      for (const entry of status) {
        cleanup.add(entry.path);
        if (entry.originalPath) cleanup.add(entry.originalPath);
      }
      const entries = (
        await this.commandAt(root, [
          "ls-files",
          "--stage",
          "--full-name",
          "-z",
          "--",
          ...targets.map(literalPath),
        ])
      )
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf("\t");
          if (tab < 0) throw new Error("Git暂存清单格式无效。");
          const [mode, hash, stage] = record.slice(0, tab).split(" ");
          if (!mode || !hash || stage !== "0")
            throw new Error("选中的路径存在未解决的冲突，请先处理。");
          return { mode, hash, path: record.slice(tab + 1) };
        });
      const head = await this.optionalAt(root, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      await this.commandAt(
        root,
        head ? ["read-tree", head] : ["read-tree", "--empty"],
        undefined,
        env,
      );
      await this.commandAt(
        root,
        ["update-index", "--force-remove", "--", ...cleanup],
        undefined,
        env,
      );
      for (const entry of entries)
        await this.commandAt(
          root,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            entry.mode,
            entry.hash,
            entry.path,
          ],
          undefined,
          env,
        );
      const tree = (
        await this.runAt(root, ["write-tree"], undefined, env)
      ).stdout.trim();
      const headTree = head
        ? (await this.commandAt(root, ["rev-parse", `${head}^{tree}`])).trim()
        : null;
      if (tree === headTree) throw new Error("没有可提交的更改。");
      const commit = await this.runAt(
        root,
        ["commit", "-m", message],
        undefined,
        env,
      );
      if (commit.code !== 0) throw new Error(commitFailure(commit));
      const hash = (
        await this.runAt(root, ["rev-parse", "HEAD"])
      ).stdout.trim();
      await this.commandAt(root, [
        "reset",
        "--quiet",
        "HEAD",
        "--",
        ...cleanup,
      ]);
      return hash;
    } finally {
      await rm(indexFile, { force: true });
    }
  }
  async commit(
    message: string,
    paths: string[] = [],
    stagedOnly = false,
  ): Promise<GitCommitResult> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("提交信息不能为空。");
    const summary = await this.summary();
    if (!summary.isRepository) throw new Error("当前目录不是Git仓库。");
    const targets = paths.length ? await this.writeTargets(paths) : [];
    const root = await this.writeRoot();
    let commitHash: string;
    if (stagedOnly && targets.length) {
      commitHash = await this.commitStagedOnly(root, trimmed, targets);
    } else {
      const result = await this.runAt(
        root,
        targets.length
          ? ["commit", "-m", trimmed, "--", ...targets.map(literalPath)]
          : ["commit", "-m", trimmed],
      );
      if (result.code !== 0) throw new Error(commitFailure(result));
      commitHash = (await this.commandAt(root, ["rev-parse", "HEAD"])).trim();
    }
    return { commitHash, summary: await this.summary() };
  }
  async switchBranch(
    targetBranchName: string,
  ): Promise<GitBranchMutationResult> {
    const action: GitBranchMutationAction = "switch";
    const name = targetBranchName.trim();
    const summary = await this.summary();
    if (!name)
      return this.mutationFailure(action, null, summary, [
        { code: "invalid-branch-name", message: "分支名不能为空。" },
      ]);
    if (!summary.isRepository)
      return this.mutationFailure(action, name, summary, [
        { code: "unknown", message: "当前目录不是Git仓库。" },
      ]);
    if (summary.branchName === name)
      return {
        ok: true,
        action,
        branchName: name,
        didChange: false,
        created: false,
        summary,
        issues: [],
      };
    if (await this.hasConflicts())
      return this.mutationFailure(action, name, summary, [
        {
          code: "conflicts-present",
          message: "工作区还有未解决的冲突，请先处理。",
        },
      ]);
    if (await this.operationInProgress())
      return this.mutationFailure(action, name, summary, [
        {
          code: "operation-in-progress",
          message: "仓库正在合并或变基，请先完成当前操作。",
        },
      ]);
    if (!(await this.validBranchName(name)))
      return this.mutationFailure(action, name, summary, [
        {
          code: "invalid-branch-name",
          message: `分支名“${name}”不是有效的Git分支名。`,
        },
      ]);
    if (!(await this.branchExists(name)))
      return this.mutationFailure(action, name, summary, [
        { code: "target-branch-not-found", message: `找不到分支“${name}”。` },
      ]);
    if (await this.branchCheckedOutElsewhere(name))
      return this.mutationFailure(action, name, summary, [
        {
          code: "branch-in-other-worktree",
          message: `分支“${name}”正被其它工作树使用。`,
        },
      ]);
    const result = await this.runAt(await this.writeRoot(), [
      "switch",
      "--no-guess",
      name,
    ]);
    if (result.code !== 0)
      return this.mutationFailure(action, name, await this.summary(), [
        ...branchMutationIssues(action, name, result),
      ]);
    const refreshed = await this.summary();
    return {
      ok: true,
      action,
      branchName: refreshed.branchName ?? name,
      didChange: true,
      created: false,
      summary: refreshed,
      issues: [],
    };
  }
  async createBranchAndSwitch(
    branchName: string,
    startPoint?: string,
  ): Promise<GitBranchMutationResult> {
    const action: GitBranchMutationAction = "create-and-switch";
    const name = branchName.trim();
    const summary = await this.summary();
    if (!name)
      return this.mutationFailure(action, null, summary, [
        { code: "invalid-branch-name", message: "分支名不能为空。" },
      ]);
    if (!summary.isRepository)
      return this.mutationFailure(action, name, summary, [
        { code: "unknown", message: "当前目录不是Git仓库。" },
      ]);
    if (await this.hasConflicts())
      return this.mutationFailure(action, name, summary, [
        {
          code: "conflicts-present",
          message: "工作区还有未解决的冲突，请先处理。",
        },
      ]);
    if (await this.operationInProgress())
      return this.mutationFailure(action, name, summary, [
        {
          code: "operation-in-progress",
          message: "仓库正在合并或变基，请先完成当前操作。",
        },
      ]);
    if (!(await this.validBranchName(name)))
      return this.mutationFailure(action, name, summary, [
        {
          code: "invalid-branch-name",
          message: `分支名“${name}”不是有效的Git分支名。`,
        },
      ]);
    if (await this.branchExists(name))
      return this.mutationFailure(action, name, summary, [
        { code: "branch-already-exists", message: `分支“${name}”已经存在。` },
      ]);
    const point = startPoint?.trim();
    const args = ["switch", "--no-guess", "-c", name];
    if (point) args.push("--", point);
    const result = await this.runAt(await this.writeRoot(), args);
    if (result.code !== 0)
      return this.mutationFailure(action, name, await this.summary(), [
        ...branchMutationIssues(action, name, result),
      ]);
    const refreshed = await this.summary();
    return {
      ok: true,
      action,
      branchName: refreshed.branchName ?? name,
      didChange: true,
      created: true,
      summary: refreshed,
      issues: [],
    };
  }
  async push(): Promise<GitPushResult> {
    const summary = await this.summary();
    if (!summary.isRepository) throw new Error("当前目录不是Git仓库。");
    const branchName = summary.branchName;
    if (!branchName) throw new Error("HEAD处于分离状态，请先切换到分支。");
    const root = await this.writeRoot();
    let setUpstream = false;
    let remoteName: string | null;
    let result: GitCommandResult;
    if (summary.trackingBranchName) {
      result = await this.runAt(root, ["push"]);
      remoteName = await this.optionalAt(root, [
        "config",
        "--get",
        `branch.${branchName}.remote`,
      ]);
    } else {
      remoteName =
        (await this.optionalAt(root, [
          "config",
          "--get",
          `branch.${branchName}.remote`,
        ])) ?? "origin";
      if (!(await this.optionalAt(root, ["remote", "get-url", remoteName])))
        throw new Error(`仓库没有名为“${remoteName}”的远端。`);
      result = await this.runAt(root, [
        "push",
        "--set-upstream",
        remoteName,
        branchName,
      ]);
      setUpstream = true;
    }
    if (result.code !== 0)
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || "Git推送失败。",
      );
    const refreshed = await this.summary();
    return {
      branchName: refreshed.branchName,
      trackingBranchName: refreshed.trackingBranchName,
      remoteName,
      setUpstream,
      summary: refreshed,
    };
  }
  private async optionalAt(cwd: string, args: readonly string[]) {
    const result = await this.runAt(cwd, args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  async graph(
    maxCount: number | undefined,
    skip: number,
  ): Promise<GitCommitGraphResult> {
    const count = Math.min(
      maxCount ?? this.session.limits.codeSearchMaxResults,
      this.session.limits.codeSearchMaxResults,
    );
    const summary = await this.summary();
    if (
      !summary.isRepository ||
      !(await this.optional(["rev-parse", "--verify", "HEAD"]))
    )
      return { commits: [], hasMore: false };
    // 多取一条仅用于hasMore，不是额外运行时预算。
    const output = await this.command([
      "log",
      "HEAD",
      "--branches",
      "--tags",
      "--remotes",
      "--date-order",
      "--topo-order",
      "--decorate=full",
      `--max-count=${count + 1}`,
      `--skip=${skip}`,
      "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%at%x00",
    ]);
    const commits = output
      .split("\0\n")
      .filter(Boolean)
      .map((record) => {
        const [
          hash = "",
          parents = "",
          decorations = "",
          subject = "",
          author = "",
          at = "",
        ] = record.trimEnd().split("\0");
        const refs = graphRefs(decorations);
        return {
          hash,
          parents: parents.split(" ").filter(Boolean),
          refs,
          subject,
          authorName: author || null,
          authoredAtMs: at ? Number(at) * 1000 : null,
        };
      });
    return {
      commits: commits.slice(0, count),
      hasMore: commits.length > count,
    };
  }
  async comparison(): Promise<GitBranchComparison> {
    const summary = await this.summary();
    const headRef = summary.branchName ?? "HEAD";
    const baseRef = summary.trackingBranchName;
    if (!summary.isRepository || !baseRef)
      return { baseRef, headRef, comparisonLabel: null, changes: [] };
    const stats = parseNumstat(
      await this.command([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "@{upstream}...HEAD",
      ]),
    );
    const fields = (
      await this.command(["diff", "--name-status", "-z", "@{upstream}...HEAD"])
    ).split("\0");
    const changes: GitFileChange[] = [];
    for (let index = 0; index < fields.length; index++) {
      const code = fields[index];
      if (!code) continue;
      let name = fields[++index];
      if (code.startsWith("R") || code.startsWith("C")) name = fields[++index];
      if (!name) throw new Error("Git分支比较缺少路径。");
      const path = join(summary.repoRoot, name);
      await this.session.resolvePath(path, "read");
      const count = stats.get(name);
      changes.push({
        path,
        repoRelativePath: name,
        workspaceRelativePath: slash(
          relative(this.session.rootDirectory, path),
        ),
        kind: code.startsWith("A")
          ? "added"
          : code.startsWith("D")
            ? "deleted"
            : code.startsWith("R")
              ? "renamed"
              : "modified",
        section: "branch",
        added: count?.added ?? 0,
        removed: count?.removed ?? 0,
        isStaged: false,
        isUntracked: false,
        isConflicted: false,
      });
    }
    if (changes.length > this.session.limits.codeSearchMaxResults)
      throw new Error("Git分支比较数量超过工作区治理上限。");
    return {
      baseRef,
      headRef,
      comparisonLabel: `${headRef} -> ${baseRef}`,
      changes,
    };
  }
  private async worktreeText(path: string) {
    const canonical = await this.session.resolvePath(path, "read");
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    if (!file) return { content: null, truncated: false, binary: false };
    try {
      const bytes = Buffer.alloc(this.session.limits.codeReadMaxBytes + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if ((await this.session.resolvePath(path, "read")) !== canonical)
        throw new Error("Git文件真实路径已变化。");
      const content = bytes.subarray(0, read.bytesRead);
      return {
        content: content.includes(0) ? null : content.toString("utf8"),
        truncated: read.bytesRead > this.session.limits.codeReadMaxBytes,
        binary: content.includes(0),
      };
    } finally {
      await file.close();
    }
  }
  private async blob(ref: string, path: string) {
    const result = await this.run(["show", `${ref}:${path}`]);
    return {
      content: result.code === 0 ? result.stdout : null,
      binary: result.code === 0 && result.stdout.includes("\0"),
      truncated:
        result.code === 0 &&
        Buffer.byteLength(result.stdout) > this.session.limits.codeReadMaxBytes,
    };
  }
  async diff(
    path: string,
    sourceId: "staged" | "unstaged" | "branch",
  ): Promise<GitDiffResult> {
    const [name] = await this.paths([path], "read");
    if (!name) throw new Error("Git差异读取需要明确文件路径。");
    const root = await this.repositoryRoot();
    const canonical = join(root, name);
    const comparison = sourceId === "branch" ? await this.comparison() : null;
    if (comparison && (!comparison.baseRef || !comparison.headRef))
      return {
        path: canonical,
        availability: "unavailable",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "当前分支没有可比较的上游提交。",
      };
    const args = comparison
      ? ["@{upstream}...HEAD"]
      : sourceId === "staged"
        ? ["--cached"]
        : [];
    let patch = await this.command([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...args,
      "--",
      name,
    ]);
    const beforeRef = comparison?.baseRef
      ? ((await this.optional(["merge-base", "@{upstream}", "HEAD"])) ??
        "@{upstream}")
      : sourceId === "staged"
        ? "HEAD"
        : "";
    const before = await this.blob(beforeRef, name);
    const beforeContent = before.content;
    const after =
      sourceId === "unstaged"
        ? await this.worktreeText(canonical)
        : await this.blob(comparison ? "HEAD" : "", name);
    if (!patch && beforeContent === null && after.content !== null) {
      patch = createTwoFilesPatch("/dev/null", `b/${name}`, "", after.content);
    }
    const binary =
      /^Binary files .+ differ$/m.test(patch) || before.binary || after.binary;
    const truncated =
      after.truncated ||
      before.truncated ||
      Buffer.byteLength(patch) > this.session.limits.codeSearchMaxBytes ||
      (beforeContent !== null &&
        Buffer.byteLength(beforeContent) >
          this.session.limits.codeReadMaxBytes);
    return {
      path: canonical,
      availability: truncated ? "truncated" : binary ? "binary" : "patch",
      patch: truncated || binary ? null : patch,
      beforeContent: truncated || binary ? null : beforeContent,
      afterContent: truncated || binary ? null : after.content,
    };
  }
}
