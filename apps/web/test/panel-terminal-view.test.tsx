// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "../src/components/workbench/panel-terminal-view";
import type {
  TerminalChannelEvent,
  WebSocketHandle,
} from "../src/hooks/use-websocket";

const { fetchTerminalShellsMock } = vi.hoisted(() => ({
  fetchTerminalShellsMock: vi.fn(),
}));

vi.mock("../src/lib/code-git-api", () => ({
  fetchTerminalShells: fetchTerminalShellsMock,
}));

/**
 * 交互式终端（R3-1 的可用形态）：一条常驻 shell，cd 保留、REPL 可连续对话。
 *
 * 这里锁三件事：起会话（带 canvasId 与 shell）、输入带上 sessionId 送出去、
 * 输出与退出如实上屏（含「连接断了要重开」这条）。
 */
describe("TerminalPane（交互式会话）", () => {
  /** 收集订阅与调用记录的 WS 替身。 */
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
              shell: "cmd",
              executable: "cmd.exe",
            });
          }
        });
      }),
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
      /** 当前会话 id（界面自己生成的）。 */
      sessionId(): string {
        const call = (handle.startTerminal as ReturnType<typeof vi.fn>).mock
          .calls[0];
        const arg = call?.[0] as { sessionId: string } | undefined;
        if (!arg) throw new Error("startTerminal 还没被调用过。");
        return String(arg.sessionId);
      },
    };
  }

  beforeEach(() => {
    fetchTerminalShellsMock.mockResolvedValue({
      shells: [
        { id: "cmd", label: "cmd", executable: "cmd.exe" },
        { id: "powershell", label: "Windows PowerShell", executable: "ps.exe" },
      ],
      defaultShell: "cmd",
      resolvedShell: "cmd",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("挂载即开会话：带上 canvasId 与设置里的默认 shell", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );

    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(1),
    );
    const payload = vi.mocked(ws.handle.startTerminal).mock.calls[0]?.[0];
    expect(payload?.canvasId).toBe("canvas-1");
    expect(payload?.shell).toBe("cmd");
    expect(payload?.sessionId).toMatch(/^term-/);
  });

  it("输入一行：本地补回显（没有 TTY），再把内容送给服务端（sessionId 对齐）", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());

    const input = await screen.findByLabelText("终端命令");
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.type(input, "cd apps{Enter}");

    expect(ws.handle.sendTerminalInput).toHaveBeenCalledWith(
      ws.sessionId(),
      "cd apps",
    );
    // 回显上屏（管道下的 shell 不会回显）
    expect(screen.getByLabelText("终端输出").textContent).toContain(
      "❯ cd apps",
    );
  });

  it("服务端输出实时上屏；会话结束如实说明退出码", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());
    const sessionId = ws.sessionId();

    ws.emit({ type: "output", sessionId, data: "PS D:\\work>\r\n" });
    expect(await screen.findByText(/PS D:\\work>/)).toBeInTheDocument();

    ws.emit({ type: "exit", sessionId, exitCode: 0 });
    expect(await screen.findByText(/会话结束 · 退出码 0/)).toBeInTheDocument();
    // 结束后输入框禁用（不能往一个已经不在的会话里打字）
    await waitFor(() =>
      expect(screen.getByLabelText("终端命令")).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: "重新开会话" }),
    ).toBeInTheDocument();
  });

  it("别的会话的输出不会串到这一条（按 sessionId 过滤）", async () => {
    const ws = makeWs();
    render(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() => expect(ws.handle.startTerminal).toHaveBeenCalled());

    ws.emit({ type: "output", sessionId: "term-别人", data: "不属于这里" });
    expect(screen.queryByText(/不属于这里/)).not.toBeInTheDocument();
  });

  it("断线：提示会重开，并把状态退回未开始（重连后自动重开）", async () => {
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
    expect(
      await screen.findByText(/连接断开，重连后会自动重开会话/),
    ).toBeInTheDocument();

    // 重连（connected 回到 true）→ 自动开一条新会话
    rerender(
      <TerminalPane accessToken="token" canvasId="canvas-1" ws={ws.handle} />,
    );
    await waitFor(() =>
      expect(ws.handle.startTerminal).toHaveBeenCalledTimes(2),
    );
  });

  it("没绑工作目录：说清楚，而不是起一个没有 cwd 的会话", async () => {
    const ws = makeWs();
    render(<TerminalPane accessToken="token" canvasId={null} ws={ws.handle} />);
    expect(
      await screen.findByText(/这个会话没有绑定工作目录/),
    ).toBeInTheDocument();
    expect(ws.handle.startTerminal).not.toHaveBeenCalled();
  });
});
