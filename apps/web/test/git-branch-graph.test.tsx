// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitBranchSelect } from "../src/components/workbench/git-branch-select";

const { fetchGitDiffStatMock, fetchGitGraphMock, fetchGitStatusMock } =
  vi.hoisted(() => ({
    fetchGitDiffStatMock: vi.fn(),
    fetchGitGraphMock: vi.fn(),
    fetchGitStatusMock: vi.fn(),
  }));

vi.mock("../src/lib/code-git-api", () => ({
  checkoutGitBranch: vi.fn(),
  commitGitAll: vi.fn(),
  createGitBranch: vi.fn(),
  fetchGitDiffStat: fetchGitDiffStatMock,
  fetchGitGraph: fetchGitGraphMock,
  fetchGitStatus: fetchGitStatusMock,
  initGitRepo: vi.fn(),
  pushGit: vi.fn(),
}));

/**
 * Git 图谱（R2-1 条目 6）的界面契约：
 * 它必须**按需**加载（开一次弹层就拉整段历史是浪费），且图形行原样呈现给用户
 * （服务端不解析画法，前端也不改写）。
 */
describe("分支弹层里的 Git 图谱", () => {
  beforeEach(() => {
    fetchGitStatusMock.mockResolvedValue({
      isRepo: true,
      branch: "main",
      branches: [{ name: "main", current: true }],
      dirty: false,
      source: "system",
    });
    fetchGitDiffStatMock.mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      untracked: 0,
    });
    fetchGitGraphMock.mockResolvedValue({
      isRepo: true,
      lines: ["* abc1234 第一轮", "|\\", "| * def5678 侧支"],
      truncated: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("展开才加载图谱，并把图形行原样画出来", async () => {
    render(<GitBranchSelect accessToken="token" canvasId="canvas-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "分支" }));
    // 还没点「Git 图谱」：不该有请求
    expect(fetchGitGraphMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Git 图谱" }));
    const pre = await screen.findByLabelText("提交图谱");
    await waitFor(() =>
      expect(fetchGitGraphMock).toHaveBeenCalledWith("token", "canvas-1"),
    );
    expect(pre.textContent).toContain("* abc1234 第一轮");
    expect(pre.textContent).toContain("| * def5678 侧支");
  });

  it("仓库还没有提交：说「还没有提交」，不是空白也不是报错", async () => {
    fetchGitGraphMock.mockResolvedValue({
      isRepo: true,
      lines: [],
      truncated: false,
    });
    render(<GitBranchSelect accessToken="token" canvasId="canvas-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "分支" }));
    await userEvent.click(screen.getByRole("button", { name: "Git 图谱" }));
    expect(await screen.findByText("还没有提交。")).toBeInTheDocument();
  });
});
