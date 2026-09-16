// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchSidePanel } from "../src/components/workbench/workbench-side-panel";

const {
  fetchCodeFilesMock,
  fetchGitChangesMock,
  fetchGitFileDiffMock,
  fetchSandboxFileMock,
  setGitFileStagedMock,
  stageGitHunkMock,
} = vi.hoisted(() => ({
  fetchCodeFilesMock: vi.fn(),
  fetchGitChangesMock: vi.fn(),
  fetchGitFileDiffMock: vi.fn(),
  fetchSandboxFileMock: vi.fn(),
  setGitFileStagedMock: vi.fn(),
  stageGitHunkMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchCodeFiles: fetchCodeFilesMock,
  fetchGitChanges: fetchGitChangesMock,
  fetchGitFileDiff: fetchGitFileDiffMock,
  fetchSandboxFile: fetchSandboxFileMock,
  setGitFileStaged: setGitFileStagedMock,
  stageGitHunk: stageGitHunkMock,
  fetchTerminalShells: vi.fn().mockResolvedValue({
    shells: [],
    defaultShell: "auto",
    resolvedShell: "cmd",
  }),
  runTerminalCommand: vi.fn(),
}));

/**
 * 右栏停靠面板（R3-1）：**编辑器式多标签**——标签是视图实例（每个文件/每个视图一个），
 * 可关，关掉后右邻接替；「+」打开新视图，左侧下拉给出全部标签（带搜索）。
 */
describe("WorkbenchSidePanel（多标签）", () => {
  beforeEach(() => {
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
          staged: false,
        },
        {
          path: "notes.md",
          additions: 0,
          deletions: 0,
          binary: false,
          status: "untracked",
          staged: false,
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
    fetchCodeFilesMock.mockResolvedValue({
      path: "",
      truncated: false,
      entries: [
        { name: "src", path: "src", type: "dir", bytes: null },
        { name: "AGENTS.md", path: "AGENTS.md", type: "file", bytes: 12 },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function Harness({ open = true }: { open?: boolean } = {}) {
    return (
      <WorkbenchSidePanel
        open={open}
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
      />
    );
  }

  /** 从「+」菜单打开一个视图（与真实操作同一条路）。 */
  async function openView(label: string) {
    await userEvent.click(screen.getByLabelText("打开视图"));
    await userEvent.click(await screen.findByRole("option", { name: label }));
  }

  it("默认开「变更」标签：头部给总数与增删、逐行给「审查 / 打开 / 撤销」", async () => {
    render(<Harness />);

    const head = await screen.findByText("个文件已更改");
    expect(head.parentElement?.textContent).toContain("2");
    expect(head.parentElement?.textContent).toContain("+12");
    expect(head.parentElement?.textContent).toContain("−3");
    const list = await screen.findByRole("list", { name: "变更文件" });
    expect(within(list).getByText("app.ts")).toBeInTheDocument();
    expect(within(list).getByText("src")).toBeInTheDocument();
    expect(within(list).getByText("notes.md")).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "审查 src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "打开 src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "撤销 src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "撤销全部更改" }),
    ).toBeInTheDocument();
  });

  it("「审查」开差异标签（未跟踪标「按新增展示」）；「打开」开只读文件标签", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });

    await userEvent.click(screen.getByRole("button", { name: "审查 notes.md" }));
    await waitFor(() =>
      expect(fetchGitFileDiffMock).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "notes.md",
      ),
    );
    expect(screen.getByText("未跟踪文件（按新增展示）")).toBeInTheDocument();
    expect(screen.getByLabelText("文件差异").textContent).toContain("+第一行");

    // 切回变更标签再开另一个文件 → 新的只读预览标签（差异标签仍在标签条上）
    await userEvent.click(screen.getByRole("tab", { name: /变更/ }));
    await userEvent.click(screen.getByRole("button", { name: "打开 src/app.ts" }));
    expect((await screen.findByLabelText("文件内容")).textContent).toContain(
      "export const app = 1;",
    );
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /app\.ts/ })).toBeInTheDocument();
  });

  it("点文件名也打开预览（用户口径：文件名本身就是入口）", async () => {
    render(<Harness />);
    const list = await screen.findByRole("list", { name: "变更文件" });
    await userEvent.click(
      within(list).getByRole("button", { name: "打开 src/app.ts 的预览" }),
    );
    expect((await screen.findByLabelText("文件内容")).textContent).toContain(
      "export const app = 1;",
    );
  });

  it("关掉激活标签：右邻接替；关掉最后一个标签给空态", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });
    await openView("终端");
    expect(screen.getByRole("tab", { name: /终端/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "关闭 终端" }));
    // 右邻没有、左邻是变更 → 激活回到变更
    expect(screen.getByRole("tab", { name: /变更/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "关闭 变更" }));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText(/没有打开的视图/)).toBeInTheDocument();
  });

  it("标签列表下拉：可搜索、可切换、可关闭", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });
    await openView("文件目录");
    await waitFor(() => expect(fetchCodeFilesMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "标签列表" }));
    const dialog = await screen.findByRole("dialog", { name: "打开的标签页" });
    expect(within(dialog).getByText("文件目录")).toBeInTheDocument();

    await userEvent.type(
      within(dialog).getByLabelText("搜索标签页"),
      "文件",
    );
    expect(within(dialog).queryByText("变更")).not.toBeInTheDocument();

    // 列表项的可访问名是「文件目录 刚刚」（关闭键是「关闭 文件目录」，这里要选前者）
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^文件目录/ }),
    );
    expect(screen.getByRole("tab", { name: /文件目录/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("没绑工作目录：变更说真话，不空转「读取中…」", async () => {
    render(
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        accessToken="token"
        canvasId={null}
        subagents={[]}
        running={false}
      />,
    );
    expect(
      await screen.findByText(/这个会话没有绑定工作目录/),
    ).toBeInTheDocument();
    expect(fetchGitChangesMock).not.toHaveBeenCalled();
  });

  it("文件目录标签：列一层、目录可进、文件可打开", async () => {
    render(<Harness />);
    await openView("文件目录");
    await waitFor(() =>
      expect(fetchCodeFilesMock).toHaveBeenCalledWith("token", "canvas-1", ""),
    );
    const list = await screen.findByRole("list", { name: "目录内容" });
    expect(within(list).getByText("src")).toBeInTheDocument();
    expect(within(list).getByText("AGENTS.md")).toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", { name: "进入 src" }));
    await waitFor(() =>
      expect(fetchCodeFilesMock).toHaveBeenLastCalledWith(
        "token",
        "canvas-1",
        "src",
      ),
    );
  });

  it("子智能体标签：没有条目时说清楚，而不是一片空白", async () => {
    render(<Harness />);
    await openView("子智能体");
    expect(
      await screen.findByText(/这个会话还没有派过子智能体/),
    ).toBeInTheDocument();
  });

  it("面板收起时仍然挂载（hidden）——终端/浏览器的状态不能因为开关被清空", async () => {
    const { rerender } = render(<Harness open />);
    await screen.findByRole("list", { name: "变更文件" });
    const panel = screen.getByLabelText("工作台面板");
    expect(panel).not.toHaveAttribute("hidden");
    rerender(<Harness open={false} />);
    expect(screen.getByLabelText("工作台面板")).toHaveAttribute("hidden");
  });

  it("审查视图可以暂存 / 取消暂存，并刷新变更清单", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });

    await userEvent.click(screen.getByRole("button", { name: "审查 src/app.ts" }));
    const stage = await screen.findByRole("button", { name: "暂存此文件" });
    setGitFileStagedMock.mockResolvedValue({ path: "src/app.ts", staged: true });
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
          staged: true,
        },
      ],
    });
    await userEvent.click(stage);

    await waitFor(() =>
      expect(setGitFileStagedMock).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "src/app.ts",
        true,
      ),
    );
    expect(
      await screen.findByRole("button", { name: "取消暂存此文件" }),
    ).toBeInTheDocument();

    // 切回变更标签：该文件标「已暂存」
    await userEvent.click(screen.getByRole("tab", { name: /变更/ }));
    const list = await screen.findByRole("list", { name: "变更文件" });
    await waitFor(() =>
      expect(within(list).getByText("已暂存")).toBeInTheDocument(),
    );
  });

  it("审查视图按块给「暂存块 / 撤销块」，都在左边（gutter 里第一个子元素）", async () => {
    fetchGitFileDiffMock.mockResolvedValueOnce({
      path: "src/app.ts",
      untracked: false,
      truncated: false,
      text: [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-old2",
        "+new2",
        " line3",
        "@@ -20,3 +20,4 @@",
        " line20",
        "+extra",
        "",
      ].join("\n"),
    });
    stageGitHunkMock.mockResolvedValue({ path: "src/app.ts", staged: true });
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });
    await userEvent.click(screen.getByRole("button", { name: "审查 src/app.ts" }));

    const buttons = await screen.findAllByRole("button", { name: /暂存第 \d 块/ });
    expect(buttons).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /撤销第 \d 块/ }),
    ).toHaveLength(2);

    await userEvent.click(buttons[1]!);

    await waitFor(() => expect(stageGitHunkMock).toHaveBeenCalledTimes(1));
    const [, , path, patch] = stageGitHunkMock.mock.calls[0]!;
    expect(path).toBe("src/app.ts");
    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).toContain("@@ -20,3 +20,4 @@");
    expect(patch).toContain("+extra");
    expect(patch).not.toContain("+new2");
  });
});

/**
 * 面板宽度口径（用户口径：面板要能灵活调大，但不能把中间的对话列挤没；
 * 拖过上限时把左栏收起来腾地方）。上限由工作台按「视口 − 左栏 − 对话列最小宽度」现算后传入。
 */
describe("面板宽度受对话列最小宽度约束", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  function Harness({
    widthLimits,
    onGrowBlocked,
  }: {
    widthLimits?: { min: number; max: number };
    onGrowBlocked?: () => void;
  }) {
    return (
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
        {...(widthLimits ? { widthLimits } : {})}
        {...(onGrowBlocked ? { onGrowBlocked } : {})}
      />
    );
  }

  function panelWidth(): number {
    const style = screen.getByLabelText("工作台面板").style.width;
    return Number(style.replace("px", ""));
  }

  function drag(widthPx: number) {
    const handle = screen.getByLabelText("调整面板宽度");
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: -widthPx });
    fireEvent.mouseUp(window, { clientX: -widthPx });
  }

  it("存过更宽的偏好也收回到当前上限内（视口变小 / 左栏重新展开）", () => {
    window.localStorage.setItem("workbench:panel-width", "900");
    render(<Harness widthLimits={{ min: 280, max: 600 }} />);
    expect(panelWidth()).toBe(600);
  });

  it("拖过上限：请求腾地方（左栏收起），且一次拖拽只请求一次", () => {
    window.localStorage.setItem("workbench:panel-width", "360");
    const onGrowBlocked = vi.fn();
    render(
      <Harness widthLimits={{ min: 280, max: 400 }} onGrowBlocked={onGrowBlocked} />,
    );

    const handle = screen.getByLabelText("调整面板宽度");
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: -500 });
    fireEvent.mouseMove(window, { clientX: -600 });
    fireEvent.mouseUp(window, { clientX: -600 });

    expect(onGrowBlocked).toHaveBeenCalledTimes(1);
    expect(panelWidth()).toBe(400);
  });

  it("没拖过上限：不动左栏", () => {
    window.localStorage.setItem("workbench:panel-width", "360");
    const onGrowBlocked = vi.fn();
    render(
      <Harness widthLimits={{ min: 280, max: 900 }} onGrowBlocked={onGrowBlocked} />,
    );
    drag(120);
    expect(onGrowBlocked).not.toHaveBeenCalled();
    expect(panelWidth()).toBe(480);
  });
});

/**
 * 「点对话里的 URL → 右栏浏览器打开」（用户口径）。
 *
 * 两个层面：模块级请求通道（有订阅者才拦截点击，没订阅者不吞掉链接默认行为），
 * 以及浏览器标签本身（地址栏补协议、iframe 渲染、系统浏览器兜底）。
 */
describe("右栏浏览器（点链接自动打开）", () => {
  afterEach(cleanup);

  function Harness() {
    return (
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
      />
    );
  }

  async function openBrowserTab() {
    await userEvent.click(screen.getByLabelText("打开视图"));
    await userEvent.click(await screen.findByRole("option", { name: "浏览器" }));
  }

  it("请求通道：没有面板时返回 false（调用方不拦截点击）", async () => {
    const { canOpenInBrowserPanel, onBrowserOpen, requestBrowserOpen } =
      await import("../src/lib/browser-panel");
    const seen: string[] = [];
    expect(requestBrowserOpen("http://localhost:3000/")).toBe(false);

    const unsubscribe = onBrowserOpen((url) => seen.push(url));
    expect(canOpenInBrowserPanel()).toBe(true);
    expect(requestBrowserOpen("http://localhost:3001/docs")).toBe(true);
    expect(seen).toEqual(["http://localhost:3001/docs"]);

    unsubscribe();
    expect(requestBrowserOpen("http://localhost:3001/")).toBe(false);
  });

  it("地址栏补协议：裸地址按 http；空串不可打开", async () => {
    const { normalizeUrl } = await import(
      "../src/components/workbench/workbench-side-panel"
    );
    expect(normalizeUrl("localhost:8000/demo")).toBe("http://localhost:8000/demo");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("地址栏回车后渲染 iframe；工具栏给后退/前进/刷新、视口预设与「在系统浏览器打开」出口", async () => {
    render(<Harness />);
    await openBrowserTab();
    expect(screen.getByRole("button", { name: "后退" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "前进" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();

    const input = screen.getByLabelText("地址");
    await userEvent.type(input, "localhost:8000{Enter}");
    expect(
      await screen.findByTitle("右栏浏览器：http://localhost:8000"),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "前进" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "localhost:8001{Enter}");
    expect(
      await screen.findByTitle("右栏浏览器：http://localhost:8001"),
    ).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "后退" });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(
      await screen.findByTitle("右栏浏览器：http://localhost:8000"),
    ).toBeInTheDocument();

    // 视口预设（用户口径：预设不做在地址栏右边，改在工具栏第二行）
    const viewport = screen.getByLabelText("视口预设");
    await userEvent.click(viewport);
    const preset = await screen.findByRole("option", { name: "1280 × 720" });
    await userEvent.click(preset);
    const frame = screen.getByTitle("右栏浏览器：http://localhost:8000");
    expect(frame.style.width).toBe("1280px");
    // 预设按比例缩放到面板里，指针坐标仍然对得上（不是拿宽度假装）
    expect(frame.style.transform).toMatch(/scale\(/);

    // 「在系统浏览器打开」在 ⋯ 菜单里（地址栏右侧，不带箭头）
    const menu = screen.getByLabelText("浏览器菜单");
    await userEvent.click(menu);
    expect(
      await screen.findByRole("option", { name: "在系统浏览器打开" }),
    ).toBeInTheDocument();

    // 元素拾取需要 CDP，不给假按钮：按钮存在但禁用
    expect(
      screen.getByRole("button", { name: /选择网页元素加入聊天/ }),
    ).toBeDisabled();
  }, 20_000);
});
