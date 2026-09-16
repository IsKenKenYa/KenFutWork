import { describe, expect, it, vi } from "vitest";

import {
  createGitClient,
  type GitCommandResult,
  isSafeBranchName,
  parseBranchList,
  toDiffStat,
  toGraph,
  toRepoView,
} from "./git-client.js";

const ok = (stdout = ""): GitCommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): GitCommandResult => ({
  code: 128,
  stdout: "",
  stderr,
});

describe("git 分支视图（纯解析）", () => {
  it("解析分支列表：NUL 分隔的 name/HEAD，按名排序并标出当前分支", () => {
    const stdout = [
      "main\u0000*",
      "feature/git-chip\u0000",
      "release-1.0\u0000",
    ].join("\n");
    expect(parseBranchList(stdout)).toEqual([
      { name: "feature/git-chip", current: false },
      { name: "main", current: true },
      { name: "release-1.0", current: false },
    ]);
  });

  it("解析容错：空行/空名被丢弃，名里的空格被裁掉", () => {
    expect(parseBranchList("\n  \n  dev \u0000*  \n")).toEqual([
      { name: "dev", current: true },
    ]);
    expect(parseBranchList("")).toEqual([]);
  });

  it("非仓库：isRepo=false 且不给分支（界面据此显示「非 Git 仓库」而不是空下拉）", () => {
    const view = toRepoView({
      branchList: ok(""),
      isRepo: fail("not a git repository"),
      status: ok(""),
    });
    expect(view).toEqual({
      isRepo: false,
      branch: null,
      branches: [],
      dirty: false,
    });
  });

  it("仓库视图：当前分支、脏状态、分支明细", () => {
    const view = toRepoView({
      branchList: ok("main\u0000*\nnext\u0000"),
      isRepo: ok("true\n"),
      status: ok(" M src/a.ts\n"),
    });
    expect(view.isRepo).toBe(true);
    expect(view.branch).toBe("main");
    expect(view.branches).toEqual([
      { name: "main", current: true },
      { name: "next", current: false },
    ]);
    expect(view.dirty).toBe(true);
  });

  it("工作区干净：porcelain 空输出即 dirty=false", () => {
    const view = toRepoView({
      branchList: ok("main\u0000*"),
      isRepo: ok("true"),
      status: ok(""),
    });
    expect(view.dirty).toBe(false);
  });

  it("status 命令失败时保守判为「可能有改动」（宁可提示，不要假装干净）", () => {
    const view = toRepoView({
      branchList: ok("main\u0000*"),
      isRepo: ok("true"),
      status: fail(),
    });
    expect(view.dirty).toBe(true);
  });

  it("detached HEAD：没有 current 分支，branch 为 null 但分支列表仍在", () => {
    const view = toRepoView({
      branchList: ok("main\u0000\nnext\u0000"),
      isRepo: ok("true"),
      status: ok(""),
    });
    expect(view.branch).toBeNull();
    expect(view.branches).toHaveLength(2);
  });
});

describe("分支名安全", () => {
  it("拒绝以 - 开头（会被 git 当选项）与非法字符", () => {
    expect(isSafeBranchName("-D")).toBe(false);
    expect(isSafeBranchName("--force")).toBe(false);
    expect(isSafeBranchName("a b")).toBe(false);
    expect(isSafeBranchName("a;rm -rf /")).toBe(false);
    expect(isSafeBranchName("a$(whoami)")).toBe(false);
    expect(isSafeBranchName("")).toBe(false);
    expect(isSafeBranchName("x".repeat(201))).toBe(false);
  });

  it("放行常规分支名（含斜杠与点）", () => {
    expect(isSafeBranchName("main")).toBe(true);
    expect(isSafeBranchName("feature/git-chip")).toBe(true);
    expect(isSafeBranchName("release-1.0.2")).toBe(true);
    expect(isSafeBranchName("future")).toBe(true);
  });
});

describe("git 客户端", () => {
  it("describe 依次执行三条命令并把结果折成视图", async () => {
    const exec = vi.fn(async (args: readonly string[], _cwd: string) => {
      if (args[0] === "rev-parse") return ok("true\n");
      if (args[0] === "branch") return ok("main\u0000*");
      if (args[0] === "status") return ok("");
      return fail();
    });
    const client = createGitClient({ exec });
    const view = await client.describe("/sandbox/x");

    expect(view.branch).toBe("main");
    expect(view.dirty).toBe(false);
    expect(exec.mock.calls.map((call) => call[0][0])).toEqual([
      "rev-parse",
      "branch",
      "status",
    ]);
    expect(exec.mock.calls[0]?.[1]).toBe("/sandbox/x");
  });

  it("checkout 用 switch 且带 cwd；失败时抛 git 的可读原因", async () => {
    const exec = vi.fn(async () => ok());
    const client = createGitClient({ exec });
    await client.checkout("/sandbox/x", "next");
    expect(exec).toHaveBeenCalledWith(["switch", "next"], "/sandbox/x");

    const failing = createGitClient({
      exec: vi.fn(async () => fail("error: pathspec 'nope' did not match")),
    });
    await expect(failing.checkout("/sandbox/x", "nope")).rejects.toThrow(
      /did not match/,
    );
  });

  it("非法分支名在**执行前**就被拒（不下发命令）", async () => {
    const exec = vi.fn(async () => ok());
    const client = createGitClient({ exec });
    await expect(client.checkout("/sandbox/x", "--force")).rejects.toThrow(
      /非法分支名/,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("更改统计（R2-1）", () => {
  it("numstat 求和增删行数；porcelain 数文件（含未跟踪）", () => {
    const stat = toDiffStat({
      numstat: ok("12\t3\tsrc/a.ts\n0\t1\tsrc/b.ts\n"),
      status: ok(" M src/a.ts\nM  src/b.ts\n?? notes.md\n"),
    });
    expect(stat).toEqual({
      files: 3,
      additions: 12,
      deletions: 4,
      untracked: 1,
    });
  });

  it("二进制文件（-/—行）不计行数但计文件", () => {
    const stat = toDiffStat({
      numstat: ok("-\t-\tlogo.png\n"),
      status: ok("?? logo.png\n"),
    });
    expect(stat).toEqual({
      files: 1,
      additions: 0,
      deletions: 0,
      untracked: 1,
    });
  });

  it("unborn HEAD（无提交）时 numstat 失败不算失败：行数为 0，文件数仍可见", () => {
    const stat = toDiffStat({
      numstat: fail("fatal: ambiguous argument 'HEAD'"),
      status: ok("?? a.md\n?? b.md\n"),
    });
    expect(stat).toEqual({
      files: 2,
      additions: 0,
      deletions: 0,
      untracked: 2,
    });
  });

  it("干净工作区：全 0", () => {
    const stat = toDiffStat({ numstat: ok(""), status: ok("") });
    expect(stat).toEqual({
      files: 0,
      additions: 0,
      deletions: 0,
      untracked: 0,
    });
  });
});

describe("git 写操作（R2-1：提交/推送/建分支）", () => {
  it("commitAll：先 add -A 再 commit -m（message 是单个 argv，不经 shell）", async () => {
    const exec = vi.fn(async (_args: readonly string[], _cwd: string) => ok());
    const client = createGitClient({ exec });
    await client.commitAll("/sandbox/x", "fix: 修复登录");
    expect(exec.mock.calls.map((call) => call[0])).toEqual([
      ["add", "-A"],
      ["commit", "-m", "fix: 修复登录"],
    ]);
  });

  it("commitAll：空信息直接拒绝，不下发命令", async () => {
    const exec = vi.fn(async () => ok());
    const client = createGitClient({ exec });
    await expect(client.commitAll("/sandbox/x", "   ")).rejects.toThrow(
      /提交信息不能为空/,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("commitAll：nothing to commit 翻译成可读文案", async () => {
    const exec = vi.fn(async (args: readonly string[]) =>
      args[0] === "commit"
        ? fail("nothing to commit, working tree clean")
        : ok(),
    );
    const client = createGitClient({ exec });
    await expect(client.commitAll("/sandbox/x", "msg")).rejects.toThrow(
      /没有可提交的更改/,
    );
  });

  it("push：无上游时给可读指引而不是裸 git stderr", async () => {
    const client = createGitClient({
      exec: vi.fn(async () =>
        fail("fatal: The current branch main has no upstream branch."),
      ),
    });
    await expect(client.push("/sandbox/x")).rejects.toThrow(/git push -u/);
  });

  it("createBranch 用 switch -c；已存在时翻译成可读文案", async () => {
    const exec = vi.fn(async () => ok());
    const client = createGitClient({ exec });
    await client.createBranch("/sandbox/x", "feature/new");
    expect(exec).toHaveBeenCalledWith(
      ["switch", "-c", "feature/new"],
      "/sandbox/x",
    );

    const exists = createGitClient({
      exec: vi.fn(async () => fail("fatal: a branch named 'x' already exists")),
    });
    await expect(exists.createBranch("/sandbox/x", "x")).rejects.toThrow(
      /已存在/,
    );
  });

  it("createBranch 的非法名字在执行前被拒", async () => {
    const exec = vi.fn(async () => ok());
    const client = createGitClient({ exec });
    await expect(client.createBranch("/sandbox/x", "-D")).rejects.toThrow(
      /非法分支名/,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

/**
 * Git 图谱（R2-1 条目 6）。
 *
 * `log --graph` 的输出里，提交行与连接线（`|` / `\` / `/`）混在一起，故「数了几条提交」
 * 必须按「剥掉图形字符后紧跟短 sha」判，否则截断判定会把连接线也算进去。
 */
describe("git 图谱（纯解析）", () => {
  it("保留图形行，并按提交行判定是否截断", () => {
    const stdout = [
      "* abc1234 第三轮",
      "* def5678 第二轮",
      "* 0123456 第一轮",
    ].join("\n");
    expect(toGraph({ result: ok(stdout), limit: 3 })).toEqual({
      lines: stdout.split("\n"),
      truncated: false,
    });
  });

  it("超过上限：只丢掉多取的那条提交（图形输出里是最后一行），标 truncated", () => {
    // 图形行不是线性的：`|\` + `| * …` 是同一条分支上的提交，故「最旧」是**最后一行**，
    // 不是「分支最深处」那条——判定按行序走，不按图形缩进。
    const stdout = [
      "* aaa1111 新",
      "|\\",
      "| * bbb2222 分支上的旧提交",
      "* ccc3333 更早的一条",
    ].join("\n");
    const graph = toGraph({ result: ok(stdout), limit: 2 });
    expect(graph.truncated).toBe(true);
    expect(graph.lines.join("\n")).not.toContain("ccc3333");
    // 其余两行一字不动（图形字符原样保留）
    expect(graph.lines).toEqual(["* aaa1111 新", "|\\", "| * bbb2222 分支上的旧提交"]);
  });

  it("无提交 / 非仓库：空图谱而不是抛错", () => {
    expect(
      toGraph({ result: fail("your current branch does not have any commits yet"), limit: 30 }),
    ).toEqual({ lines: [], truncated: false });
  });

  it("客户端执行时带 --no-color 且多取一条（用于判断是否还有更早的历史）", async () => {
    const exec = vi.fn(async () => ok("* abc1234 x"));
    const client = createGitClient({ exec });
    await client.graph("/sandbox/x", 30);
    expect(exec).toHaveBeenCalledWith(
      [
        "log",
        "--graph",
        "--oneline",
        "--decorate",
        "--all",
        "--no-color",
        "-n",
        "31",
      ],
      "/sandbox/x",
    );
  });
});
