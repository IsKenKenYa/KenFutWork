// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "../src/components/workbench/panel-terminal-view";
import type {
  TerminalChannelEvent,
  WebSocketHandle,
} from "../src/hooks/use-websocket";

const { fetchTerminalShellsMock, xterm } = vi.hoisted(() => ({
  fetchTerminalShellsMock: vi.fn(),
  /** 替身模拟器实例登记表（xterm 依赖 canvas / matchMedia，jsdom 里跑不了真的）。 */
  xterm: {
    instances: [] as Array<{
      cols: number;
      rows: number;
      written: string[];
      cleared: number;
      dataHandlers: Array<(data: string) => void>;
      resizeHandlers: Array<(size: { cols: number; rows: number }) => void>;
    }>,
  },
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchTerminalShells: fetchTerminalShellsMock,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    written: string[] = [];
    cleared = 0;
    dataHandlers: Array<(data: string) => void> = [];
    resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
    constructor() {
      xterm.instances.push(this as never);
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      this.written.push(data);
    }
    clear() {
      this.cleared += 1;
    }
    dispose() {}
    focus() {}
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return { dispose: () => {} };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandlers.push(handler);
      return { dispose: () => {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/**
 * 终端（R3-1）：**真 PTY + xterm 模拟器**的多标签交互式会话。
 *
 * 这里锁的是**数据方向**（真 PTY 的行为在服务端的真机用例里验）：
 * 按键原样送服务端、尺寸报给服务端、输出写进模拟器、标签与右键菜单可用。
 */
describe("TerminalPane（PTY + 模拟器）", () => {
  function makeWs(connected = true) {
    const listeners = new Set<(event: TerminalChannelEvent) => void>();
    const handle = {
      connected,
      startRun: vi.fn(),
      cancelRun: vi.fn(),
      onEvent: () => () => {},
      registerRPC: () => () => {},
      resumeCanvas: vi.fn(),
      startTerminal: vi.fn((payload: { sessionId: string }) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              type: "started",
              sessionId: payload.sessionId,
              shell: "powershell",
              executable: "powershell.exe",
            });
          }
        });
      }),
      resizeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      stopTerminal: vi.fn(),
      onTerminal: (cb: (event: TerminalChannelEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    } as unknown as WebSocketHandle;

    return {
      handle,
      emit(event: TerminalChannelEvent) {
        for (const listener of listeners) listener(event);
      },
      sessionId(): string {
        const call = (handle.startTerminal as ReturnType<typeof vi.fn>).mock
          .calls[0];
        const arg = call?.[0] as { sessionId: string } | undefined;
        if (!arg) throw new Error("startTerminal 还没被调用过。");
        return String(arg.sessionId);
      },
    };
  }

  const termOf = (index: number) => {
    const term = xterm.instances[index];
    if (!term) throw new Error(`第 ${index} 个模拟器未创建`);
    return term;
  };

  beforeEach(() => {
    xterm.instances.length = 0;
    fetchTerminalShellsMock.mockResolvedValue({
      shells: [
        { id: "cmd", label: "cmd", executable: "cmd.exe" },
        {
          id: "powershell",
          label: "Windows PowerShell",
          executable: "ps.exe",
        },
      ],
      defaultShell: "auto",
      resolvedShell: "powershell",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("挂载即开会话：带 canvasId、**不带 shell**（系统默认由服务端解析），并把尺寸报过去", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );

    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    const payload = vi.mocked(ws.handle.startTerminal).mock.calls[0]?.[0];
    expect(payload?.canvasId).toBe("canvas-1");
    // 用户口径「不要选择，自动进入系统默认配置的终端」：客户端不挑壳
    expect(payload?.shell).toBeUndefined();
    expect(payload?.sessionId).toMatch(/^term-/);
    // 标签上是服务端 ack 回来的**实际** shell
    expect(
      await screen.findByRole("button", {
        name: /^终端标签：Windows PowerShell$/,
      }),
    ).toBeInTheDocument();
    // 模拟器量出格子数就告诉 PTY（否则 shell 以为自己是 80×24）
    expect(ws.handle.resizeTerminal).toHaveBeenCalledWith(
      ws.sessionId(),
      80,
      24,
    );
  });

  it("按键**原样**送服务端（行编辑 / 回显归 shell）：回车是 \\r，方向键是转义序列", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^终端标签：/ });

    const term = termOf(0);
    await waitFor(() => expect(term.dataHandlers.length).toBeGreaterThan(0));
    for (const handler of term.dataHandlers) handler("Get-ChildItem\r");
    expect(ws.handle.sendTerminalInput).toHaveBeenCalledWith(
      ws.sessionId(),
      "Get-ChildItem\r",
    );
    for (const handler of term.dataHandlers) handler("\u001b[A");
    expect(ws.handle.sendTerminalInput).toHaveBeenCalledWith(
      ws.sessionId(),
      "\u001b[A",
    );
  });

  it("尺寸变化报给服务端（PSReadLine / 全屏程序靠它排版）", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^终端标签：/ });

    const term = termOf(0);
    await waitFor(() => expect(term.resizeHandlers.length).toBeGreaterThan(0));
    for (const handler of term.resizeHandlers) handler({ cols: 120, rows: 40 });
    expect(ws.handle.resizeTerminal).toHaveBeenCalledWith(
      ws.sessionId(),
      120,
      40,
    );
  });

  it("输出写进模拟器（ANSI 由模拟器解析）；别的会话的输出不串台", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^终端标签：/ });
    const sessionId = ws.sessionId();

    ws.emit({ type: "output", sessionId, data: "\u001b[32mPS>\u001b[0m " });
    expect(termOf(0).written).toContain("\u001b[32mPS>\u001b[0m ");

    ws.emit({ type: "output", sessionId: "term-别人", data: "不属于这里" });
    expect(termOf(0).written).not.toContain("不属于这里");
  });

  it("会话结束：状态变「已结束」、屏上写明退出码、给「重新开会话」", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^终端标签：/ });

    ws.emit({ type: "exit", sessionId: ws.sessionId(), exitCode: 0 });
    expect(
      await screen.findByRole("button", { name: "重新开会话" }),
    ).toBeInTheDocument();
    expect(termOf(0).written.join("")).toContain("退出码 0");
  });

  it("清屏：清的是模拟器缓冲，不动会话", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    await screen.findByRole("button", { name: /^终端标签：/ });
    expect(termOf(0).cleared).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "清屏" }));
    expect(termOf(0).cleared).toBe(1);
    expect(ws.handle.stopTerminal).not.toHaveBeenCalled();
  });

  it("新建 / 关闭标签：每个标签一个模拟器，关掉当前标签由邻居接替", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    await userEvent.click(screen.getByRole("button", { name: "新建终端" }));
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(2),
    );
    expect(xterm.instances).toHaveLength(2);

    const [firstClose] = screen.getAllByRole("button", {
      name: /关闭终端标签：/,
    });
    await userEvent.click(firstClose as HTMLElement);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /关闭终端标签：/ }),
      ).toHaveLength(1),
    );
    expect(ws.handle.stopTerminal).toHaveBeenCalledTimes(1);
  });

  it("标签页右键：列出可切换的终端，切过去 = 换一条新会话", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    const tab = await screen.findByRole("button", {
      name: /^终端标签：Windows PowerShell$/,
    });

    await userEvent.pointer({ target: tab, keys: "[MouseRight]" });

    const menu = await screen.findByRole("menu", { name: "终端标签菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitemradio", { name: /^cmd$/ }),
    );

    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(2),
    );
    const payload = vi.mocked(ws.handle.startTerminal).mock.calls[1]?.[0];
    expect(payload?.shell).toBe("cmd");
    expect(payload?.canvasId).toBe("canvas-1");
  });

  it("断线：状态退回未开始；重连后自动重开（新会话）", async () => {
    const ws = makeWs();
    const { rerender } = render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());

    const disconnected = { ...ws.handle, connected: false } as WebSocketHandle;
    rerender(
      <TerminalPane
        accessToken="token"
        canvasId="canvas-1"
        ws={disconnected}
      />,
    );
    await waitFor(() => expect(screen.getByText("未连接")).toBeInTheDocument());

    rerender(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(2),
    );
  });

  it("StrictMode 下也只开一个标签、不杀刚起的会话", async () => {
    const ws = makeWs();
    const { StrictMode } = await import("react");
    render(
      <StrictMode>
        <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getAllByRole("button", { name: /^终端标签：/ })).toHaveLength(
      1,
    );
    // StrictMode 的「假卸载」不许把刚起的会话杀掉（真机实测过：会显示「客户端关闭了终端」）
    expect(ws.handle.stopTerminal).not.toHaveBeenCalled();
  });

  it("起不来时不无限转圈：10 秒没有 ack → 标成已结束 + 可重开（真机见过「卡在正在开…」）", async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      // 让 startTerminal 不回 started：模拟服务端没回应（真机那次是被未处理拒绝带走）
      vi.mocked(ws.handle.startTerminal).mockImplementation(() => {});
      render(
        <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_100);
      });
      expect(screen.getByText(/会话没能起来/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "重新开会话" }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("没绑工作目录也能开：不带 canvasId 起会话（cwd 由服务端兜底）", async () => {
    const ws = makeWs();
    render(<TerminalPane accessToken="token" canvasId={null} ws={ws.handle} />);
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    const payload = vi.mocked(ws.handle.startTerminal).mock.calls[0]?.[0];
    // 用户口径「终端不应该限制绑定文件目录」：不再拦在这里
    expect(payload?.canvasId).toBeUndefined();
    expect(termOf(0)).toBeTruthy();
  });
});
