import { describe, expect, it, vi } from "vitest";

import {
  createGitClient,
  type GitCommandResult,
  isSafeBranchName,
  parseBranchList,
  toChangedFiles,
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
  const F = "\u001f";
  const row = (rail: string, fields: string[]) => rail + F + fields.join(F);

  it("解析出图/描述/日期/作者/提交与 refs，并保留连接线行", () => {
    const stdout = [
      row("* ", [
        "aaa1111full",
        "aaa1111",
        "future73807",
        "2026-09-16T17:08:00+08:00",
        "第三轮",
        "HEAD -> main, origin/main",
        "bbb2222full",
      ]),
      "|\\",
      row("| * ", [
        "bbb2222full",
        "bbb2222",
        "future73807",
        "2026-09-16T16:00:00+08:00",
        "分支上的旧提交",
        "",
        "ccc3333full",
      ]),
    ].join("\n");

    const graph = toGraph({ result: ok(stdout), limit: 10 });
    expect(graph.truncated).toBe(false);
    expect(graph.entries).toHaveLength(3);
    expect(graph.entries[0]).toMatchObject({
      rail: "* ",
      sha: "aaa1111full",
      shortSha: "aaa1111",
      subject: "第三轮",
      author: "future73807",
      date: "2026-09-16T17:08:00+08:00",
      refs: ["HEAD -> main", "origin/main"],
      parents: ["bbb2222full"],
    });
    // 连接线行保留（否则分支图形缺笔画）：rail-only，无提交字段
    expect(graph.entries[1]).toMatchObject({ sha: null, subject: "" });
    expect(graph.entries[2]).toMatchObject({
      rail: "| * ",
      sha: "bbb2222full",
    });
    expect(graph.entries[2]?.refs).toEqual([]);
  });

  it("超过上限：丢掉行序末尾的那条提交（含它前面的图形行），标 truncated", () => {
    const stdout = [
      row("* ", [
        "aaa",
        "aaa1111",
        "a",
        "2026-09-16T00:00:00+08:00",
        "新",
        "",
        "",
      ]),
      "|\\",
      row("| * ", [
        "bbb",
        "bbb2222",
        "a",
        "2026-09-15T00:00:00+08:00",
        "旧",
        "",
        "",
      ]),
      row("* ", [
        "ccc",
        "ccc3333",
        "a",
        "2026-09-14T00:00:00+08:00",
        "更旧",
        "",
        "",
      ]),
    ].join("\n");

    const graph = toGraph({ result: ok(stdout), limit: 2 });
    expect(graph.truncated).toBe(true);
    expect(graph.entries.map((entry) => entry.shortSha)).toEqual([
      "aaa1111",
      null,
      "bbb2222",
    ]);
  });

  it("无提交 / 非仓库：空图谱而不是抛错", () => {
    expect(
      toGraph({
        result: fail("your current branch does not have any commits yet"),
        limit: 30,
      }),
    ).toEqual({ entries: [], truncated: false });
  });

  it("客户端：结构化 format + --no-color，且多取一条用于判截断", async () => {
    // 形参要写全（`ExecGit` 的 args 是 readonly string[]），否则 mock 的调用记录类型为 []
    const exec = vi.fn(async (_args: readonly string[], _cwd: string) =>
      ok(
        row("* ", [
          "abc",
          "abc1234",
          "a",
          "2026-09-16T00:00:00+08:00",
          "x",
          "",
          "",
        ]),
      ),
    );
    const client = createGitClient({ exec });
    await client.graph("/sandbox/x", 30);

    const args = exec.mock.calls[0]?.[0] ?? [];
    expect(args[0]).toBe("log");
    expect(args).toContain("--graph");
    expect(args).toContain("--no-color");
    expect(args.join(" ")).toContain("%x1f");
    expect(args.slice(-2)).toEqual(["-n", "31"]);
  });
});

/**
 * 变更清单（R3-2）。
 *
 * 两份输入各讲一半事实：numstat 给行数但看不到未跟踪文件，porcelain 给状态但不给行数。
 * 合并口径（骨架取 numstat、状态查表、未跟踪补末尾）与「二进制不伪造行数」在这里锁死。
 */
describe("变更清单（纯解析）", () => {
  it("合并 numstat 与 porcelain：行数来自前者、状态来自后者，未跟踪补在末尾", () => {
    const numstat = ok(
      [
        "12\t3\tsrc/app.ts",
        "-\t-\tpublic/logo.png",
        "7\t7\tsrc/new-name.ts",
      ].join("\n"),
    );
    const status = ok(
      [
        " M src/app.ts",
        " M public/logo.png",
        "R  src/old-name.ts -> src/new-name.ts",
        "?? notes.md",
      ].join("\n"),
    );

    expect(toChangedFiles({ numstat, status, maxFiles: 50 })).toEqual({
      files: [
        {
          path: "notes.md",
          additions: 0,
          deletions: 0,
          binary: false,
          status: "untracked",
          // `??` 的第一个字符不是空格，但**未跟踪不是已暂存**
          staged: false,
        },
        {
          path: "public/logo.png",
          additions: 0,
          deletions: 0,
          binary: true,
          status: "modified",
          staged: false,
        },
        {
          path: "src/app.ts",
          additions: 12,
          deletions: 3,
          binary: false,
          status: "modified",
          staged: false,
        },
        {
          path: "src/new-name.ts",
          additions: 7,
          deletions: 7,
          binary: false,
          status: "renamed",
          // `R ` 的 X 位是 R：重命名已进索引
          staged: true,
        },
      ],
      truncated: false,
    });
  });

  it("大括号形式的重命名路径归约成新路径", () => {
    const numstat = ok("3\t1\tsrc/{old => new}/index.ts");
    const status = ok("");
    const files = toChangedFiles({ numstat, status, maxFiles: 10 }).files;
    expect(files.map((file) => file.path)).toEqual(["src/new/index.ts"]);
  });

  it("未跟踪目录不进列表（git 把目录折叠成带尾斜杠的一条，列出来只会让人点开报错）", () => {
    const files = toChangedFiles({
      numstat: fail("fatal: ambiguous argument 'HEAD'"),
      // `?? hello-kfw/modes/` 是**目录**；同目录下的文件才会被 git 单独列出
      status: ok("?? hello-kfw/modes/\n?? hello-kfw/README.md\n M src/a.ts\n"),
      maxFiles: 10,
    }).files;
    // numstat 失败（无提交）时只补未跟踪条目：文件照旧列出，目录被丢掉
    expect(files.map((file) => file.path)).toEqual(["hello-kfw/README.md"]);
    expect(files.some((file) => file.path.endsWith("/"))).toBe(false);
  });

  it("仓库还没有提交（numstat 非零退出）：未跟踪文件仍要列出来", () => {
    const files = toChangedFiles({
      numstat: fail("fatal: ambiguous argument 'HEAD'"),
      status: ok("?? first.md\n?? src/draft.ts"),
      maxFiles: 10,
    }).files;
    expect(files.map((file) => file.path)).toEqual([
      "first.md",
      "src/draft.ts",
    ]);
    expect(files.every((file) => file.status === "untracked")).toBe(true);
  });

  it("超过上限：截断并标注（列表按路径排序，分页口径稳定）", () => {
    const numstat = ok(["1\t1\tc.ts", "1\t1\ta.ts", "1\t1\tb.ts"].join("\n"));
    const result = toChangedFiles({ numstat, status: ok(""), maxFiles: 2 });
    expect(result.truncated).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("客户端：changedFiles 同时拉 status 与 numstat；fileDiff 对空 diff 给可读原因", async () => {
    // `ExecGit` 的 args 是 `readonly string[]`：mock 的形参得同宽，否则不可赋值
    const exec = vi.fn(async (args: readonly string[], _cwd: string) =>
      args[0] === "status" ? ok("?? a.md") : ok(""),
    );
    const client = createGitClient({ exec });
    const changes = await client.changedFiles("/sandbox/x", 50);
    expect(changes.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(exec).toHaveBeenCalledWith(["status", "--porcelain"], "/sandbox/x");
    expect(exec).toHaveBeenCalledWith(
      ["diff", "--numstat", "HEAD"],
      "/sandbox/x",
    );

    // 未跟踪文件在 diff HEAD 里是空的：不能返回空字符串假装「没变化」
    await expect(client.fileDiff("/sandbox/x", "a.md", 4096)).rejects.toThrow(
      /没有可显示的差异/,
    );
  });

  /**
   * 暂存 / 取消暂存（参考图审查视图的「暂存」）：命令本身要逐字锁住——
   * 取消暂存用 `restore --staged`（新版 git 对「新增文件的反向暂存」也能正确处理）。
   */
  it("客户端：暂存走 git add，取消暂存走 git restore --staged", async () => {
    const exec = vi.fn(async (_args: readonly string[], _cwd: string) =>
      ok(""),
    );
    const client = createGitClient({ exec });

    await client.stageFile("/sandbox/x", "src/app.ts", true);
    expect(exec).toHaveBeenCalledWith(
      ["add", "--", "src/app.ts"],
      "/sandbox/x",
    );

    await client.stageFile("/sandbox/x", "src/app.ts", false);
    expect(exec).toHaveBeenCalledWith(
      ["restore", "--staged", "--", "src/app.ts"],
      "/sandbox/x",
    );
  });

  it("客户端：暂存失败把 git 的原话抛出来（不吞成静默失败）", async () => {
    const exec = vi.fn(async (_args: readonly string[], _cwd: string) =>
      fail("fatal: pathspec 'nope' did not match any files"),
    );
    const client = createGitClient({ exec });
    await expect(client.stageFile("/sandbox/x", "nope", true)).rejects.toThrow(
      /pathspec/,
    );
  });

  it("客户端：fileDiff 超上限截断并标注", async () => {
    const exec = vi.fn(async () => ok("x".repeat(100)));
    const client = createGitClient({ exec });
    const text = await client.fileDiff("/sandbox/x", "a.ts", 10);
    expect(text).toContain("…（已截断）");
    expect(exec).toHaveBeenCalledWith(
      ["diff", "--no-color", "HEAD", "--", "a.ts"],
      "/sandbox/x",
    );
  });
});
