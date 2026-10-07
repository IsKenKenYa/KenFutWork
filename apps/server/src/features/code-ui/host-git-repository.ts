import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { InstanceSettings } from "@kenfutwork/shared";
import type {
  GitBranchComparison,
  GitCommitGraphRef,
  GitCommitGraphResult,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitLocalBranchListResult,
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
  const entries: Array<{ path: string; x: string; y: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ")
      throw new Error("Git状态格式无效。");
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    entries.push({ path: entry.slice(3), x, y });
    if (x === "R" || x === "C" || y === "R" || y === "C") index++;
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

/** 原IGitService的DTO投影；exec只来自真实Task ProcessSandbox，不启动宿主shell。 */
export class CodeUiHostGitRepository {
  constructor(readonly session: CodeUiHostGitSession) {}
  run(args: readonly string[], input?: string) {
    if (!this.session.available) throw new Error("当前环境没有可用Git。");
    return this.session.exec(args, this.session.rootDirectory, input);
  }
  async command(args: readonly string[], input?: string) {
    return requireSuccess(await this.run(args, input));
  }
  async optional(args: readonly string[]) {
    const result = await this.run(args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  async repositoryRoot() {
    const root = await this.optional(["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error("当前Task目录不是Git仓库。");
    return this.session.resolvePath(root, "read");
  }
  async paths(paths: string[], operation: "read" | "write") {
    const root = await this.repositoryRoot();
    const result: string[] = [];
    for (const path of paths) {
      if (!path || path.includes("\0"))
        throw new Error("Git文件路径不能为空或包含NUL。");
      const canonical = await this.session.resolvePath(
        isAbsolute(path) ? path : join(this.session.rootDirectory, path),
        operation,
      );
      const tail = relative(root, canonical);
      if (isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`))
        throw new Error("Git路径越出仓库根。");
      result.push(slash(tail));
    }
    if (result.length > this.session.limits.codeSearchMaxResults)
      throw new Error("Git路径数量超过工作区治理上限。");
    return result;
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
