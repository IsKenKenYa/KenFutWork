// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatSidebar,
  type SidePanelTab,
} from "../src/components/chat-sidebar";
import { TierLimitToastProvider } from "../src/components/credits/tier-limit-toast";
import { ToastProvider } from "../src/components/toast";
import type { WebSocketHandle } from "../src/hooks/use-websocket";

const {
  createSessionMock,
  deleteSessionMock,
  fetchExecutionModeMock,
  fetchExecutionModesMock,
  fetchImageModelsMock,
  fetchMessagesMock,
  fetchModelsMock,
  fetchSessionsMock,
  fetchWorkspaceSkillsMock,
  saveMessageMock,
  updateSessionTitleMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchExecutionModeMock: vi.fn(),
  fetchExecutionModesMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  fetchWorkspaceSkillsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchExecutionMode: fetchExecutionModeMock,
  fetchExecutionModes: fetchExecutionModesMock,
  fetchImageModels: fetchImageModelsMock,
  fetchMessages: fetchMessagesMock,
  fetchModels: fetchModelsMock,
  fetchSessions: fetchSessionsMock,
  fetchWorkspaceSkills: fetchWorkspaceSkillsMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
}));

function createMockWs(): WebSocketHandle {
  return {
    connected: true,
    resumeCanvas: vi.fn(),
    startRun: vi.fn((payload, onAck) => {
      // Simulate server ack
      onAck?.({
        type: "command.ack",
        action: "agent.run",
        payload: { runId: "run_123" },
      });
    }),
    cancelRun: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
  };
}

describe("ChatSidebar", () => {
  let mockWs: WebSocketHandle;

  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    // jsdom does not implement matchMedia; use-breakpoint relies on it.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mockWs = createMockWs();
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue({
      session: {
        id: "session-created",
        title: "New Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
    deleteSessionMock.mockReset();
    fetchMessagesMock.mockReset();
    fetchMessagesMock.mockResolvedValue({ messages: [] });
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [] });
    fetchImageModelsMock.mockReset();
    fetchExecutionModesMock.mockReset();
    fetchExecutionModesMock.mockResolvedValue({ modes: ["agent", "plan"] });
    fetchExecutionModeMock.mockReset();
    fetchExecutionModeMock.mockResolvedValue({ mode: "agent" });
    fetchImageModelsMock.mockResolvedValue({ models: [] });
    fetchWorkspaceSkillsMock.mockReset();
    fetchWorkspaceSkillsMock.mockResolvedValue({ skills: [] });
    fetchSessionsMock.mockReset();
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        {
          id: "session-real",
          title: "Existing Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    updateSessionTitleMock.mockReset();
    updateSessionTitleMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("starts runs via WebSocket with the active real session id", async () => {
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/输入你的想法/);
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "hello loom",
          canvasId: "canvas-1",
        }),
        expect.any(Function),
      ),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("图层/文件是另两个视图（图标切换），且切过去不顶掉对话标签行", async () => {
    function Harness() {
      const [tab, setTab] = useState<SidePanelTab>("layers");
      return (
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
          panelTab={tab}
          onPanelTabChange={setTab}
          layersPanel={<div>图层列表占位</div>}
          filesPanel={<div>生成文件占位</div>}
        />
      );
    }

    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <Harness />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    // 图层视图：显示图层内容、不渲染对话输入区，但**标签行仍在**（切视图不影响多标签页）
    expect(await screen.findByText("图层列表占位")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/输入你的想法/)).toBeNull();
    expect(
      screen.getByRole("tablist", { name: "打开的对话" }),
    ).toBeInTheDocument();
    // 原「Agent 助手」标题已由标签页取代
    expect(screen.queryByText("Agent 助手")).toBeNull();

    // 点「生成文件」→ 切到文件视图
    await userEvent.click(screen.getByRole("button", { name: "生成文件" }));
    expect(await screen.findByText("生成文件占位")).toBeInTheDocument();
    expect(screen.queryByText("图层列表占位")).toBeNull();

    // 点「对话」→ 切回对话视图（新增的回到对话按钮）
    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(
      await screen.findByPlaceholderText(/输入你的想法/),
    ).toBeInTheDocument();
  });

  it("对话视图里显示「打开的对话」标签页，当前会话占一个标签且可关闭", async () => {
    render(
      <ToastProvider>
        <TierLimitToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </TierLimitToastProvider>
      </ToastProvider>,
    );

    const tablist = await screen.findByRole("tablist", { name: "打开的对话" });
    expect(tablist).toBeInTheDocument();
    // 当前会话自动成为一个标签（mock 的历史列表里只有 "Existing Chat"）
    const tab = await screen.findByRole("tab", { name: "Existing Chat" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("button", { name: "关闭 Existing Chat" }),
    ).toBeInTheDocument();
    // 历史记录入口仍在（点历史对话＝新开一个标签）
    expect(screen.getByRole("button", { name: /历史记录/ })).toBeInTheDocument();

    // 标签页是面板的第一行：执行模式排在它下面，不得压在它上面
    const mode = await screen.findByRole("combobox", { name: "执行模式" });
    const order = tablist.compareDocumentPosition(mode);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
