// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkDirectorySelect } from "../src/components/workbench/work-directory-select";

const { fetchCodeDocsMock, fetchSandboxFileMock } = vi.hoisted(() => ({
  fetchCodeDocsMock: vi.fn(),
  fetchSandboxFileMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchCodeDocs: fetchCodeDocsMock,
  fetchSandboxFile: fetchSandboxFileMock,
}));

const PROJECTS = [
  {
    id: "proj-1",
    name: "test",
    kind: "code",
    primaryCanvas: { id: "canvas-1" },
  },
] as never;

/**
 * 项目文档入口（R3-3）：清单按需拉（关着不请求）、「打开」把内容显示在浮窗里。
 */
describe("工作目录下拉里的项目文档", () => {
  beforeEach(() => {
    fetchCodeDocsMock.mockResolvedValue([{ path: "AGENTS.md", bytes: 12 }]);
    fetchSandboxFileMock.mockResolvedValue({
      path: "AGENTS.md",
      bytes: 12,
      truncated: false,
      binary: false,
      content: "# 仓库指南\n",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSelect = () =>
    render(
      <WorkDirectorySelect
        projects={PROJECTS}
        selectedProjectId="proj-1"
        accessToken="token"
        canvasId="canvas-1"
        onSelect={() => {}}
        onOpenFolder={() => {}}
        onClear={() => {}}
      />,
    );

  it("关着不发请求；打开才拉清单并列出文档", async () => {
    renderSelect();
    expect(fetchCodeDocsMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    await waitFor(() =>
      expect(fetchCodeDocsMock).toHaveBeenCalledWith("token", "canvas-1"),
    );
    expect(await screen.findByText("AGENTS.md")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开 AGENTS.md" }),
    ).toBeInTheDocument();
  });

  it("目录里没有文档时说明白（不是一片空白）", async () => {
    fetchCodeDocsMock.mockResolvedValue([]);
    renderSelect();
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(
      await screen.findByText("这个目录里没有 AGENTS.md / README.md 等文档"),
    ).toBeInTheDocument();
  });

  it("「打开」在浮窗里显示文件内容", async () => {
    renderSelect();
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "打开 AGENTS.md" }),
    );

    await waitFor(() =>
      expect(fetchSandboxFileMock).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "AGENTS.md",
      ),
    );
    expect((await screen.findByLabelText("文档内容")).textContent).toContain(
      "# 仓库指南",
    );
  });
});
