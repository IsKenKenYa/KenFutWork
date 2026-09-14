import { describe, expect, it, vi } from "vitest";

import {
  createGitClient,
  type GitCommandResult,
  isSafeBranchName,
  parseBranchList,
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
