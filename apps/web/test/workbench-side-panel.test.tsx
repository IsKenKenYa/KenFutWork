// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkbenchSidePanel,
  type WorkbenchPanelTab,
} from "../src/components/workbench/workbench-side-panel";

/**
 * 这个文件现在有 14 个面板用例、每个都要真渲染 + user-event 交互，
 * 并行跑全仓时默认 1s 的异步查询预算不够（单跑 ~3s、并行下会偶发超时）。
 */
configure({ asyncUtilTimeout: 5000 });

const {
  fetchCodeDocsMock,
  fetchCodeFilesMock,
  fetchGitChangesMock,
  fetchGitFileDiffMock,
  fetchSandboxFileMock,
  setGitFileStagedMock,
  stageGitHunkMock,
} = vi.hoisted(() => ({
  fetchCodeDocsMock: vi.fn(),
  fetchCodeFilesMock: vi.fn(),
  fetchGitChangesMock: vi.fn(),
  fetchGitFileDiffMock: vi.fn(),
  fetchSandboxFileMock: vi.fn(),
  setGitFileStagedMock: vi.fn(),
  stageGitHunkMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchCodeDocs: fetchCodeDocsMock,
  fetchCodeFiles: fetchCodeFilesMock,
  fetchGitChanges: fetchGitChangesMock,
  fetchGitFileDiff: fetchGitFileDiffMock,
  fetchSandboxFile: fetchSandboxFileMock,
  setGitFileStaged: setGitFileStagedMock,
  stageGitHunk: stageGitHunkMock,
}));

/**
 * 右栏停靠面板（R3-1 的形态：参考图里「变更 / 文档 / 子智能体」都在右侧面板的标签页里，
 * 不是一次性弹层）。这里锁三件事：切标签换正文、逐文件「审查 / 打开」、空态说真话。
 */
describe("WorkbenchSidePanel", () => {
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
    fetchCodeDocsMock.mockResolvedValue([{ path: "AGENTS.md", bytes: 12 }]);
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
  });

  function Harness({ initialTab = "changes" as WorkbenchPanelTab }) {
    const [tab, setTab] = useState<WorkbenchPanelTab>(initialTab);
    return (
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        tab={tab}
        onTabChange={setTab}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
      />
    );
  }

  it("变更标签：头部给总数与增删、逐行给「审查 / 打开」", async () => {
    render(<Harness />);

    // 头部一行：N 个文件已更改 + 总增删（参考图的读法）
    const head = await screen.findByText("个文件已更改");
    expect(head.parentElement?.textContent).toContain("2");
    expect(head.parentElement?.textContent).toContain("+12");
    expect(head.parentElement?.textContent).toContain("−3");
    const list = await screen.findByRole("list", { name: "变更文件" });
    // 参考图的读法：文件名 + 路径 + 统计；这里两个文件分别在 src/ 与根目录
    expect(within(list).getByText("app.ts")).toBeInTheDocument();
    expect(within(list).getByText("src")).toBeInTheDocument();
    expect(within(list).getByText("notes.md")).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "审查 src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "打开 src/app.ts" }),
    ).toBeInTheDocument();
  });

  it("未跟踪文件的「审查」标「按新增展示」；「打开」显示文件内容", async () => {
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

    // 返回列表 → 打开另一文件看内容
    await userEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await userEvent.click(screen.getByRole("button", { name: "打开 src/app.ts" }));
    expect((await screen.findByLabelText("文件内容")).textContent).toContain(
      "export const app = 1;",
    );
  });

  it("切到文档标签：列出文档并可打开内容（不串到变更标签的数据）", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });

    await userEvent.click(screen.getByRole("tab", { name: "文档" }));
    await waitFor(() =>
      expect(fetchCodeDocsMock).toHaveBeenCalledWith("token", "canvas-1"),
    );
    const docs = await screen.findByRole("list", { name: "项目文档" });
    expect(within(docs).getByText("AGENTS.md")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "打开 AGENTS.md" }));
    expect((await screen.findByLabelText("文件内容")).textContent).toContain(
      "export const app = 1;",
    );
  });

  it("没绑工作目录：变更与文档都说真话，不空转「读取中…」", async () => {
    render(
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        tab="changes"
        onTabChange={() => {}}
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
    render(<Harness initialTab="files" />);
    await waitFor(() =>
      expect(fetchCodeFilesMock).toHaveBeenCalledWith("token", "canvas-1", ""),
    );
    const list = await screen.findByRole("list", { name: "目录内容" });
    expect(within(list).getByText("src")).toBeInTheDocument();
    expect(within(list).getByText("AGENTS.md")).toBeInTheDocument();

    // 进子目录 → 用新路径再拉一次
    await userEvent.click(within(list).getByRole("button", { name: "进入 src" }));
    await waitFor(() =>
      expect(fetchCodeFilesMock).toHaveBeenLastCalledWith("token", "canvas-1", "src"),
    );
  });

  it("子智能体标签：没有条目时说清楚，而不是一片空白", async () => {
    render(<Harness initialTab="subagents" />);
    expect(
      await screen.findByText(/这个会话还没有派过子智能体/),
    ).toBeInTheDocument();
  });
});

/**
 * 面板宽度口径（用户口径：面板要能灵活调大，但不能把中间的对话列挤没；
 * 拖过上限时把左栏收起来腾地方）。上限由工作台按「视口 − 左栏 − 对话列最小宽度」现算后传入。
 */
describe("面板宽度受对话列最小宽度约束", () => {
  /** 面板的宽度是模块级 localStorage 偏好，用例之间必须清干净。 */
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
    const [tab, setTab] = useState<WorkbenchPanelTab>("changes");
    return (
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        tab={tab}
        onTabChange={setTab}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
        {...(widthLimits ? { widthLimits } : {})}
        {...(onGrowBlocked ? { onGrowBlocked } : {})}
      />
    );
  }

  /** 面板当前渲染宽度（px）。 */
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
    // 宽度仍夹在上限内（上限要等工作台把左栏收起后才变）
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
  /** 这个 describe 里的用例会连开好几个面板渲染，必须逐个清干净（否则查询命中两份 DOM）。 */
  afterEach(cleanup);

  function Harness({
    initialTab = "changes" as WorkbenchPanelTab,
  }: {
    initialTab?: WorkbenchPanelTab;
  }) {
    const [tab, setTab] = useState<WorkbenchPanelTab>(initialTab);
    return (
      <WorkbenchSidePanel
        open
        onClose={() => {}}
        tab={tab}
        onTabChange={setTab}
        accessToken="token"
        canvasId="canvas-1"
        subagents={[]}
        running={false}
      />
    );
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

  it("地址栏回车后渲染 iframe；工具栏给后退/前进/刷新与「在系统浏览器打开」出口", async () => {
    render(<Harness initialTab="browser" />);
    // 还没有打开过页面：后退/前进/刷新都是禁用的（不摆能点但没反应的键）
    expect(screen.getByRole("button", { name: "后退" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "前进" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();

    const input = screen.getByLabelText("地址");
    await userEvent.type(input, "localhost:8000{Enter}");
    expect(
      await screen.findByTitle("右栏浏览器：http://localhost:8000"),
    ).toBeInTheDocument();

    // 打开过一页后刷新可用、前进仍不可用；再开一页才出现后退
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

    // 「在系统浏览器打开」在 ⋯ 菜单里（地址栏右侧）
    const menu = screen.getByLabelText("浏览器菜单");
    await userEvent.click(menu);
    expect(
      await screen.findByRole("option", { name: "在系统浏览器打开" }),
    ).toBeInTheDocument();

    // 元素拾取需要 CDP，不给假按钮：按钮存在但禁用
    expect(
      screen.getByRole("button", { name: /选择网页元素加入聊天/ }),
    ).toBeDisabled();
    // 这条要开两页 + 回退/前进 + 开菜单，并行跑全仓时默认 5s 不够（单跑 ~1.4s）
  }, 20_000);

  it("审查视图可以暂存 / 取消暂存，并刷新变更清单", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "变更文件" });

    await userEvent.click(screen.getByRole("button", { name: "审查 src/app.ts" }));
    const stage = await screen.findByRole("button", { name: "暂存此文件" });
    setGitFileStagedMock.mockResolvedValue({ path: "src/app.ts", staged: true });
    fetchGitChangesMock.mockResolvedValueOnce({
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
    await userEvent.click(stage);

    await waitFor(() =>
      expect(setGitFileStagedMock).toHaveBeenCalledWith(
        "token",
        "canvas-1",
        "src/app.ts",
        true,
      ),
    );
    // 暂存后按钮变「取消暂存」（仍在差异视图里）
    expect(
      await screen.findByRole("button", { name: "取消暂存此文件" }),
    ).toBeInTheDocument();
    // 回列表：该文件标「已暂存」
    await userEvent.click(screen.getByRole("button", { name: "返回列表" }));
    const list = await screen.findByRole("list", { name: "变更文件" });
    expect(within(list).getByText("已暂存")).toBeInTheDocument();
  });

  it("审查视图按块给「暂存块」：只发这一块的 patch（文件头 + 块）", async () => {
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

    // 两个块 = 两个「暂存块」键
    const buttons = await screen.findAllByRole("button", { name: /暂存第 \d 块/ });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);

    await waitFor(() => expect(stageGitHunkMock).toHaveBeenCalledTimes(1));
    const [, , path, patch] = stageGitHunkMock.mock.calls[0]!;
    expect(path).toBe("src/app.ts");
    // 第二块的 patch：带文件头、只带第二块
    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).toContain("@@ -20,3 +20,4 @@");
    expect(patch).toContain("+extra");
    expect(patch).not.toContain("+new2");
  });
});
