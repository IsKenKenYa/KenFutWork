// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitBranchSelect } from "../src/components/workbench/git-branch-select";

const {
  fetchGitChangesMock,
  fetchGitDiffStatMock,
  fetchGitFileDiffMock,
  fetchGitStatusMock,
  fetchSandboxFileMock,
} = vi.hoisted(() => ({
  fetchGitChangesMock: vi.fn(),
  fetchGitDiffStatMock: vi.fn(),
  fetchGitFileDiffMock: vi.fn(),
  fetchGitStatusMock: vi.fn(),
  fetchSandboxFileMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  checkoutGitBranch: vi.fn(),
  commitGitAll: vi.fn(),
  createGitBranch: vi.fn(),
  fetchGitChanges: fetchGitChangesMock,
  fetchGitDiffStat: fetchGitDiffStatMock,
  fetchGitFileDiff: fetchGitFileDiffMock,
  fetchGitGraph: vi.fn(),
  fetchGitStatus: fetchGitStatusMock,
  fetchSandboxFile: fetchSandboxFileMock,
  initGitRepo: vi.fn(),
  pushGit: vi.fn(),
}));

/**
 * 变更列表（R3-2）的界面契约：逐文件 +/−、「审查」给 diff、「打开」给文件内容。
 * 三者都按需加载——开弹层就拉一堆 diff 是浪费。
 */
describe("分支弹层里的变更列表", () => {
  beforeEach(() => {
    fetchGitStatusMock.mockResolvedValue({
      isRepo: true,
      branch: "main",
      branches: [{ name: "main", current: true }],
      dirty: true,
      source: "system",
    });
    fetchGitDiffStatMock.mockResolvedValue({
      files: 2,
      additions: 12,
      deletions: 3,
      untracked: 1,
    });
    fetchGitChangesMock.mockResolvedValue({
      isRepo: true,
      truncated: false,
      files: [
        {
          path: "src/app.ts",
          additions: 12,
          deletions: 3,
          binary: false,
          status: "modified",
        },
        {
          path: "notes.md",
          additions: 0,
          deletions: 0,
          binary: false,
          status: "untracked",
        },
      ],
    });
    fetchGitFileDiffMock.mockResolvedValue({
      path: "notes.md",
      text: "+第一行\n+第二行",
      truncated: false,
      untracked: true,
    });
    fetchSandboxFileMock.mockResolvedValue({
      path: "src/app.ts",
      bytes: 42,
      truncated: false,
      binary: false,
      content: "export const app = 1;\n",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("展开才加载清单，逐文件给 +/− 与「审查 / 打开」", async () => {
    render(<GitBranchSelect accessToken="token" canvasId="canvas-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "分支" }));

    expect(fetchGitChangesMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "变更列表" }));

    await waitFor(() =>
      expect(fetchGitChangesMock).toHaveBeenCalledWith("token", "canvas-1"),
    );
    // 汇总行也有 +12 / −3：断言限定在清单里，避免两个位置互相顶替
    const list = await screen.findByRole("list", { name: "变更文件" });
    expect(within(list).getByText("src/app.ts")).toBeInTheDocument();
    expect(within(list).getByText("notes.md")).toBeInTheDocument();
    expect(within(list).getByText("+12")).toBeInTheDocument();
    expect(within(list).getByText("−3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "审查 src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开 src/app.ts" }),
    ).toBeInTheDocument();
  });

  it("「审查」显示 diff；未跟踪文件标注「按新增展示」", async () => {
    render(<GitBranchSelect accessToken="token" canvasId="canvas-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "分支" }));
    await userEvent.click(screen.getByRole("button", { name: "变更列表" }));

    await userEvent.click(
      await screen.findByRole("button", { name: "审查 notes.md" }),
    );
    const panel = await screen.findByLabelText("文件内容");
    expect(panel.textContent).toContain("+第一行");
    expect(screen.getByText("未跟踪文件（按新增展示）")).toBeInTheDocument();
  });

  it("「打开」显示文件内容（读的是工作目录里的那份）", async () => {
    render(<GitBranchSelect accessToken="token" canvasId="canvas-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "分支" }));
    await userEvent.click(screen.getByRole("button", { name: "变更列表" }));

    await userEvent.click(
      await screen.findByRole("button", { name: "打开 src/app.ts" }),
    );
    await waitFor(() =>
      expect(fetchSandboxFileMock).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "src/app.ts",
      ),
    );
    expect((await screen.findByLabelText("文件内容")).textContent).toContain(
      "export const app = 1;",
    );
  });
});
