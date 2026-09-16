// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatCommitDate,
  GitGraphDialog,
} from "../src/components/workbench/git-graph-dialog";

const { fetchGitGraphMock } = vi.hoisted(() => ({
  fetchGitGraphMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchGitGraph: fetchGitGraphMock,
}));

/**
 * Git 图谱（参考图 `git图谱.png`）：独立窗口里的表格（图/描述/日期/作者/提交），
 * 连接线行保留（否则分支图形缺笔画），选中提交给出详情。
 */
describe("GitGraphDialog", () => {
  beforeEach(() => {
    fetchGitGraphMock.mockResolvedValue({
      isRepo: true,
      truncated: false,
      entries: [
        {
          rail: "* ",
          sha: "e050aaefull",
          shortSha: "e050aae",
          subject: "收进右栏停靠面板",
          author: "future73807",
          date: "2026-09-16T17:08:00+08:00",
          refs: ["HEAD -> main", "origin/main"],
          parents: ["1e4e518full"],
        },
        {
          rail: "|\\",
          sha: null,
          shortSha: null,
          subject: "",
          author: "",
          date: "",
          refs: [],
          parents: [],
        },
        {
          rail: "| * ",
          sha: "1e4e518full",
          shortSha: "1e4e518",
          subject: "开发库临时集群脚本",
          author: "future73807",
          date: "2026-09-16T16:53:00+08:00",
          refs: [],
          parents: [],
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("渲染表格：图/描述/日期/作者/提交，refs 作为徽标挂在描述前", async () => {
    render(
      <GitGraphDialog
        open
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
      />,
    );

    await waitFor(() =>
      expect(fetchGitGraphMock).toHaveBeenCalledWith("token", "canvas-1"),
    );
    expect(screen.getByText("描述")).toBeInTheDocument();
    expect(screen.getByText("日期")).toBeInTheDocument();
    expect(screen.getByText("作者")).toBeInTheDocument();
    expect(screen.getByText("提交")).toBeInTheDocument();

    expect(screen.getByText("收进右栏停靠面板")).toBeInTheDocument();
    expect(screen.getByText("HEAD -> main")).toBeInTheDocument();
    expect(screen.getByText("origin/main")).toBeInTheDocument();
    expect(screen.getByText("e050aae")).toBeInTheDocument();
    expect(screen.getByText("09/16 17:08")).toBeInTheDocument();
    // 连接线行也在（rail-only）
    expect(screen.getByText("|\\")).toBeInTheDocument();
  });

  it("点一行给出该提交的详情（含父提交）", async () => {
    render(
      <GitGraphDialog
        open
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
      />,
    );
    await screen.findByText("收进右栏停靠面板");

    await userEvent.click(screen.getByText("收进右栏停靠面板"));
    const detail = screen.getByText("主题").closest("dl");
    expect(detail).not.toBeNull();
    expect(
      within(detail as HTMLElement).getByText("e050aaefull"),
    ).toBeInTheDocument();
    expect(
      within(detail as HTMLElement).getByText("1e4e518"),
    ).toBeInTheDocument();
  });

  it("非仓库 / 没有提交：说清状态，不是空白", async () => {
    fetchGitGraphMock.mockResolvedValue({
      isRepo: true,
      truncated: false,
      entries: [],
    });
    render(
      <GitGraphDialog
        open
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
      />,
    );
    expect(await screen.findByText("还没有提交。")).toBeInTheDocument();
  });

  it("日期格式化：ISO → MM/DD HH:mm；解析不了就原样返回", () => {
    expect(formatCommitDate("2026-09-16T17:08:00+08:00")).toMatch(
      /^09\/16 \d{2}:\d{2}$/,
    );
    expect(formatCommitDate("不是日期")).toBe("不是日期");
  });
});
