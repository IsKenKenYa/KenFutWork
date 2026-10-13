// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { StreamEvent } from "@kenfutwork/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSidebar, type SidePanelTab } from "../src/components/chat-sidebar";
import { ToastProvider } from "../src/components/toast";
import type { WebSocketHandle } from "../src/hooks/use-websocket";

const {
  createSessionMock,
  deleteSessionMock,
  fetchDesignTaskPolicyMock,
  fetchDesignTaskApprovalsMock,
  fetchDesignGoalMock,
  createDesignGoalMock,
  pauseDesignGoalMock,
  resumeDesignGoalMock,
  setDesignGoalBudgetMock,
  fetchExecutionModeMock,
  fetchExecutionModesMock,
  fetchImageModelsMock,
  fetchMessagesMock,
  fetchModelsMock,
  fetchSessionsMock,
  fetchInstanceSkillsMock,
  saveMessageMock,
  provisionDesignTaskMock,
  updateDesignTaskPolicyMock,
  resolveDesignTaskApprovalMock,
  updateSessionTitleMock,
  ApiApplicationErrorMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchDesignTaskPolicyMock: vi.fn(),
  fetchDesignTaskApprovalsMock: vi.fn(),
  fetchDesignGoalMock: vi.fn(),
  createDesignGoalMock: vi.fn(),
  pauseDesignGoalMock: vi.fn(),
  resumeDesignGoalMock: vi.fn(),
  setDesignGoalBudgetMock: vi.fn(),
  fetchExecutionModeMock: vi.fn(),
  fetchExecutionModesMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  fetchInstanceSkillsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  provisionDesignTaskMock: vi.fn(),
  updateDesignTaskPolicyMock: vi.fn(),
  resolveDesignTaskApprovalMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
  ApiApplicationErrorMock: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchDesignTaskPolicy: fetchDesignTaskPolicyMock,
  fetchDesignTaskApprovals: fetchDesignTaskApprovalsMock,
  fetchDesignGoal: fetchDesignGoalMock,
  createDesignGoal: createDesignGoalMock,
  pauseDesignGoal: pauseDesignGoalMock,
  resumeDesignGoal: resumeDesignGoalMock,
  setDesignGoalBudget: setDesignGoalBudgetMock,
  fetchExecutionMode: fetchExecutionModeMock,
  fetchExecutionModes: fetchExecutionModesMock,
  fetchImageModels: fetchImageModelsMock,
  fetchMessages: fetchMessagesMock,
  fetchModels: fetchModelsMock,
  fetchSessions: fetchSessionsMock,
  fetchInstanceSkills: fetchInstanceSkillsMock,
  provisionDesignTask: provisionDesignTaskMock,
  updateDesignTaskPolicy: updateDesignTaskPolicyMock,
  resolveDesignTaskApproval: resolveDesignTaskApprovalMock,
  ApiApplicationError: ApiApplicationErrorMock,

  // 语音：输入框挂载时会读一次功能模式（读不到按默认档，不影响本文件用例）
  fetchVoiceSettings: vi.fn(async () => ({
    settings: {
      mode: "transcribe",
      listen: null,
      think: null,
      speak: null,
      speakReplies: false,
    },
  })),
  transcribeVoice: vi.fn(async () => ""),
  refineVoice: vi.fn(async () => ""),
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
}));

const eventListeners: Array<
  (event: StreamEvent, seq?: number, taskId?: string) => void
> = [];
let nextDelivery: "running" | "queued" = "running";

function createMockWs(): WebSocketHandle {
  return {
    connected: true,
    resumeTask: vi.fn(),
    resumeCanvas: vi.fn(),
    reconnectNow: vi.fn(),
    startRun: vi.fn((payload, onAck) => {
      // Simulate server ack
      onAck?.({
        type: "command.ack",
        action: "agent.run",
        payload: {
          runId: "run_123",
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          inputId: payload.inputId,
          scopeGeneration: payload.scopeGeneration,
          branchGeneration: payload.branchGeneration,
          delivery: nextDelivery,
        },
      });
    }),
    cancelRun: vi.fn(),
    onEvent: vi.fn((callback: Parameters<WebSocketHandle["onEvent"]>[0]) => {
      eventListeners.push(callback);
      return () => {
        const index = eventListeners.indexOf(callback);
        if (index >= 0) eventListeners.splice(index, 1);
      };
    }),
    registerRPC: vi.fn(() => () => {}),
    startTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    stopTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    onTerminal: vi.fn(() => () => {}),
  };
}

describe("ChatSidebar", () => {
  let mockWs: WebSocketHandle;

  beforeEach(() => {
    localStorage.removeItem("kenfutwork:agent-model");
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
    eventListeners.length = 0;
    nextDelivery = "running";
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
    fetchDesignTaskPolicyMock.mockReset();
    fetchDesignTaskPolicyMock.mockResolvedValue({
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
    });
    fetchDesignTaskApprovalsMock.mockReset();
    fetchDesignTaskApprovalsMock.mockResolvedValue({ approvals: [] });
    fetchDesignGoalMock.mockReset().mockResolvedValue({
      goal: null,
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
      acceptedRunId: null,
    });
    createDesignGoalMock.mockReset();
    pauseDesignGoalMock.mockReset();
    resumeDesignGoalMock.mockReset();
    setDesignGoalBudgetMock.mockReset();
    fetchExecutionModesMock.mockReset();
    fetchExecutionModesMock.mockResolvedValue({ modes: ["agent", "plan"] });
    fetchExecutionModeMock.mockReset();
    fetchExecutionModeMock.mockResolvedValue({ mode: "agent" });
    fetchImageModelsMock.mockResolvedValue({ models: [] });
    fetchInstanceSkillsMock.mockReset();
    fetchInstanceSkillsMock.mockResolvedValue({ skills: [] });
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
    saveMessageMock.mockResolvedValue({
      message: { id: "message-persisted", role: "user", contentBlocks: [] },
    });
    provisionDesignTaskMock.mockReset();
    provisionDesignTaskMock.mockResolvedValue({
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
    });
    updateDesignTaskPolicyMock.mockReset();
    updateDesignTaskPolicyMock.mockResolvedValue({
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 3,
        branchGeneration: 3,
        mode: "build",
        planEnabled: true,
        planningEpoch: 1,
        activeRunId: null,
        executionState: "ready",
      },
    });
    resolveDesignTaskApprovalMock.mockReset();
    resolveDesignTaskApprovalMock.mockResolvedValue({
      status: "resolved",
      decision: "allow",
    });
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
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/输入你的想法/);
    await waitFor(() =>
      expect(mockWs.resumeTask).toHaveBeenCalledWith(
        "session-real",
        0,
        expect.any(Function),
      ),
    );
    expect(mockWs.resumeCanvas).not.toHaveBeenCalled();
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "session-real",
          taskId: "session-real",
          inputId: "message-persisted",
          scopeGeneration: 2,
          branchGeneration: 3,
          prompt: "hello loom",
          canvasId: "canvas-1",
          preset: "design",
        }),
        expect.any(Function),
      ),
    );
    expect(saveMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      (
        mockWs.startRun as unknown as {
          mock: { invocationCallOrder: number[] };
        }
      ).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("refreshes only the active relinked Design Task from authoritative state", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/输入你的想法/);
    await waitFor(() =>
      expect(fetchDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
      ),
    );
    fetchDesignTaskPolicyMock.mockClear();
    fetchDesignGoalMock.mockClear();
    const message = (origin: string, source: WindowProxy, taskId: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: {
            type: "workbench:project-directory-relinked",
            projectId: "project-real",
            tasks: [taskId],
          },
        }),
      );

    message("https://other.example", window.parent, "session-real");
    message(window.location.origin, {} as WindowProxy, "session-real");
    message(window.location.origin, window.parent, "another-task");
    expect(fetchDesignTaskPolicyMock).not.toHaveBeenCalled();

    fetchDesignTaskPolicyMock.mockResolvedValue({
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace/replacement",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 4,
        branchGeneration: 4,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
    });
    fetchDesignGoalMock.mockResolvedValue({
      goal: null,
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace/replacement",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 4,
        branchGeneration: 4,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
      acceptedRunId: null,
    });
    message(window.location.origin, window.parent, "session-real");

    await waitFor(() =>
      expect(fetchDesignTaskPolicyMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
      ),
    );
    await waitFor(() =>
      expect(fetchDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
      ),
    );
    await userEvent.type(
      screen.getByPlaceholderText(/输入你的想法/),
      "重关联后继续{Enter}",
    );
    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ scopeGeneration: 4, branchGeneration: 4 }),
        expect.any(Function),
      ),
    );
  });

  it("does not let an older reconnect read replace the relinked Task fence", async () => {
    const oldTask = {
      taskId: "session-real",
      projectId: "project-real",
      canvasId: "canvas-1",
      rootDirectory: "/workspace",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      scopeGeneration: 2,
      branchGeneration: 3,
      mode: "build" as const,
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: null,
      executionState: "ready" as const,
    };
    const relinkedTask = {
      ...oldTask,
      rootDirectory: "/workspace/replacement",
      scopeGeneration: 4,
      branchGeneration: 4,
    };
    mockWs.connected = false;
    let resolveLateRead: ((value: { task: typeof oldTask }) => void) | null =
      null;
    let relinkRequested = false;
    fetchDesignTaskPolicyMock.mockImplementation(() => {
      if (mockWs.connected && !relinkRequested) {
        return new Promise((resolve) => {
          resolveLateRead = resolve;
        });
      }
      return Promise.resolve({
        task: relinkRequested ? relinkedTask : oldTask,
      });
    });
    fetchDesignGoalMock.mockImplementation(async () => ({
      goal: null,
      task: relinkRequested ? relinkedTask : oldTask,
      acceptedRunId: null,
    }));
    let connect: (() => void) | null = null;
    function ConnectionHarness() {
      const [connected, setConnected] = useState(false);
      mockWs.connected = connected;
      connect = () => setConnected(true);
      return (
        <ToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </ToastProvider>
      );
    }
    render(<ConnectionHarness />);
    await waitFor(() => expect(fetchDesignGoalMock).toHaveBeenCalled());
    fetchDesignGoalMock.mockClear();
    await act(async () => connect?.());
    await waitFor(() => expect(resolveLateRead).toBeTypeOf("function"));
    relinkRequested = true;

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window.parent,
          data: {
            type: "workbench:project-directory-relinked",
            projectId: "project-real",
            tasks: ["session-real"],
          },
        }),
      );
    });
    await waitFor(() => expect(fetchDesignGoalMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveLateRead?.({ task: oldTask });
      await Promise.resolve();
    });
    createDesignGoalMock.mockResolvedValue({
      goal: null,
      task: relinkedTask,
      acceptedRunId: null,
    });
    await userEvent.type(
      await screen.findByPlaceholderText(/输入你的想法/),
      "/goal 继续工作{Enter}",
    );

    await waitFor(() =>
      expect(createDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.objectContaining({ expectedBranchGeneration: 4 }),
      ),
    );
  });

  it("creates a persistent goal with the current branch-generation fence", async () => {
    const response = {
      goal: null,
      acceptedRunId: null,
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
    };
    createDesignGoalMock.mockResolvedValue(response);
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );
    await userEvent.type(
      await screen.findByPlaceholderText(/输入你的想法/),
      "/goal 完成画布首页{Enter}",
    );

    await waitFor(() =>
      expect(createDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        {
          objective: "完成画布首页",
          tokenBudget: null,
          expectedBranchGeneration: 3,
          expectedGoal: null,
        },
      ),
    );
  });

  it("creates a persistent goal with the explicitly selected model", async () => {
    localStorage.setItem("kenfutwork:agent-model", "provider-uuid:model-id");
    createDesignGoalMock.mockResolvedValue({
      goal: null,
      acceptedRunId: null,
      task: {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      },
    });
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );
    await userEvent.type(
      await screen.findByPlaceholderText(/输入你的想法/),
      "/goal 按选择模型创建{Enter}",
    );

    await waitFor(() =>
      expect(createDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.objectContaining({
          expectedBranchGeneration: 3,
          model: "provider-uuid:model-id",
        }),
      ),
    );
  });

  it.each([
    { selectedModel: null, modelRequest: {} },
    {
      selectedModel: "provider-uuid:model-id",
      modelRequest: { model: "provider-uuid:model-id" },
    },
  ])(
    "resumes a persistent Goal with the selected model when present",
    async ({ selectedModel, modelRequest }) => {
      if (selectedModel)
        localStorage.setItem("kenfutwork:agent-model", selectedModel);
      const task = {
        taskId: "session-real",
        projectId: "project-real",
        canvasId: "canvas-1",
        rootDirectory: "/workspace",
        additionalDirectories: [],
        sandboxMode: "workspace-write",
        scopeGeneration: 2,
        branchGeneration: 3,
        mode: "build",
        planEnabled: false,
        planningEpoch: 0,
        activeRunId: null,
        executionState: "ready",
      };
      const goal = {
        goalId: "goal-paused",
        revision: 2,
        objective: "完成设计",
        status: "paused",
        branchGeneration: 3,
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 5,
        iteration: 1,
        claimedRunId: null,
        lastSettledRunId: "run-paused",
        runTokensUsed: 12,
        runUsageObserved: true,
        runStartedAt: null,
        verification: null,
        reason: "手动暂停",
      };
      fetchDesignGoalMock.mockResolvedValue({
        goal,
        task,
        acceptedRunId: null,
      });
      resumeDesignGoalMock.mockResolvedValue({
        goal: { ...goal, status: "active" },
        task,
        acceptedRunId: null,
      });
      render(
        <ToastProvider>
          <ChatSidebar
            accessToken="token_abc"
            canvasId="canvas-1"
            open
            onToggle={() => {}}
            ws={mockWs}
          />
        </ToastProvider>,
      );
      await userEvent.type(
        await screen.findByPlaceholderText(/输入你的想法/),
        "/goal resume{Enter}",
      );

      await waitFor(() =>
        expect(resumeDesignGoalMock).toHaveBeenCalledWith(
          "token_abc",
          "session-real",
          {
            goalId: "goal-paused",
            revision: 2,
            branchGeneration: 3,
            ...modelRequest,
          },
        ),
      );
    },
  );

  it("shows a readable directory relink reason for a paused Goal", async () => {
    const task = {
      taskId: "session-real",
      projectId: "project-real",
      canvasId: "canvas-1",
      rootDirectory: "/workspace/replacement",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      scopeGeneration: 4,
      branchGeneration: 4,
      mode: "build",
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: null,
      executionState: "ready",
    };
    fetchDesignGoalMock.mockResolvedValue({
      goal: {
        goalId: "goal-paused",
        revision: 2,
        objective: "完成设计",
        status: "paused",
        branchGeneration: 4,
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 5,
        iteration: 1,
        claimedRunId: null,
        lastSettledRunId: "run-paused",
        runTokensUsed: 12,
        runUsageObserved: true,
        runStartedAt: null,
        verification: null,
        reason: "project.directoryRelink",
      },
      task,
      acceptedRunId: null,
    });
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    expect(await screen.findByPlaceholderText(/输入你的想法/)).toBeEnabled();
    expect(screen.queryByRole("region", { name: "持续目标" })).toBeNull();
    expect(
      screen.queryByText("project.directoryRelink"),
    ).not.toBeInTheDocument();
  });

  it("replaces a terminal Goal using its persisted identity and revision", async () => {
    const task = {
      taskId: "session-real",
      projectId: "project-real",
      canvasId: "canvas-1",
      rootDirectory: "/workspace",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      scopeGeneration: 2,
      branchGeneration: 3,
      mode: "build",
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: null,
      executionState: "ready",
    };
    const oldGoal = {
      goalId: "goal-old",
      revision: 4,
      objective: "旧目标",
      status: "complete",
      branchGeneration: 3,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 4,
      iteration: 1,
      claimedRunId: null,
      lastSettledRunId: "run-old",
      runTokensUsed: 10,
      runUsageObserved: true,
      runStartedAt: null,
      verification: null,
      reason: "已完成",
    };
    const nextGoal = {
      ...oldGoal,
      goalId: "goal-new",
      revision: 1,
      objective: "新目标",
      status: "active",
      reason: null,
    };
    const response = (goal: typeof oldGoal | typeof nextGoal) => ({
      goal,
      task,
      acceptedRunId: null,
    });
    let created = false;
    let reads = 0;
    let finishBackgroundRefresh:
      | ((value: ReturnType<typeof response>) => void)
      | undefined;
    fetchDesignGoalMock.mockImplementation(() => {
      reads += 1;
      if (reads === 2)
        return new Promise((resolve) => {
          finishBackgroundRefresh = resolve;
        });
      return Promise.resolve(response(created ? nextGoal : oldGoal));
    });
    createDesignGoalMock.mockImplementation(async () => {
      created = true;
      return response(nextGoal);
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );
    const objectiveInput = await screen.findByPlaceholderText(/输入你的想法/);
    await userEvent.type(objectiveInput, "/goal 新目标");
    await waitFor(() => expect(finishBackgroundRefresh).toBeDefined());
    finishBackgroundRefresh?.(response(oldGoal));
    await waitFor(() => expect(objectiveInput).toHaveValue("/goal 新目标"));
    await userEvent.type(objectiveInput, "{Enter}");

    await waitFor(() =>
      expect(createDesignGoalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        {
          objective: "新目标",
          tokenBudget: null,
          expectedBranchGeneration: 3,
          expectedGoal: { goalId: "goal-old", revision: 4 },
        },
      ),
    );
  });

  it("applies a refreshed active Goal Run delta once through the Task event consumer", async () => {
    const task = {
      taskId: "session-real",
      projectId: "project-real",
      canvasId: "canvas-1",
      rootDirectory: "/workspace",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      scopeGeneration: 2,
      branchGeneration: 3,
      mode: "build",
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: "goal-run",
      executionState: "ready",
    };
    const goal = {
      goalId: "goal-real",
      revision: 1,
      objective: "完成设计",
      status: "active",
      branchGeneration: 3,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      iteration: 1,
      claimedRunId: "goal-run",
      lastSettledRunId: null,
      runTokensUsed: 0,
      runUsageObserved: false,
      runStartedAt: null,
      verification: null,
      reason: null,
    };
    const response = { goal, task, acceptedRunId: "goal-run" };
    fetchDesignGoalMock.mockResolvedValue(response);
    mockWs.resumeTask = vi.fn((_taskId, _seq, onAck) => {
      onAck?.({
        type: "command.ack",
        action: "task.resume",
        payload: {
          taskId: "session-real",
          canvasId: "canvas-1",
          latestSeq: 0,
          activeRunId: "goal-run",
          replayGap: false,
        },
      });
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );
    await waitFor(() => expect(mockWs.resumeTask).toHaveBeenCalled());
    await waitFor(() => expect(eventListeners).toHaveLength(1));

    act(() => {
      for (const listener of [...eventListeners])
        listener(
          {
            type: "message.delta",
            runId: "goal-run",
            messageId: "message-1",
            delta: "single-delta",
            timestamp: new Date().toISOString(),
          },
          1,
          "session-real",
        );
    });

    await waitFor(() =>
      expect(screen.getByRole("log").textContent).toContain("single-delta"),
    );
    expect(
      screen.getByRole("log").textContent?.match(/single-delta/g),
    ).toHaveLength(1);
  });

  it("persists selected Canvas images into a queued Goal input and keeps the user Run stoppable after Goal completion", async () => {
    const task = {
      taskId: "session-real",
      projectId: "project-real",
      canvasId: "canvas-1",
      rootDirectory: "/workspace",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      scopeGeneration: 2,
      branchGeneration: 3,
      mode: "build",
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: null,
      executionState: "ready",
    };
    const goal = (status: "active" | "complete") => ({
      goalId: "goal-real",
      revision: status === "active" ? 1 : 2,
      objective: "完成画布首页",
      status,
      branchGeneration: 3,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      iteration: 1,
      claimedRunId: status === "active" ? "goal-run" : null,
      lastSettledRunId: status === "complete" ? "goal-run" : null,
      runTokensUsed: 10,
      runUsageObserved: true,
      runStartedAt: null,
      verification: null,
      reason: null,
    });
    const goalResponse = (state: "active" | "complete") => ({
      goal: goal(state),
      task: state === "complete" ? { ...task, activeRunId: "run_123" } : task,
      acceptedRunId: state === "active" ? "goal-run" : null,
    });
    let goalCreated = false;
    let goalCompleted = false;
    fetchDesignGoalMock.mockImplementation(async () => {
      if (!goalCreated) return { goal: null, task, acceptedRunId: null };
      return goalResponse(goalCompleted ? "complete" : "active");
    });
    createDesignGoalMock.mockImplementation(async () => {
      goalCreated = true;
      return goalResponse("active");
    });
    nextDelivery = "queued";

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
          selectedCanvasElements={[
            {
              id: "canvas-image-1",
              type: "image",
              x: 0,
              y: 0,
              width: 32,
              height: 32,
              fileId: "file-1",
              dataUrl: "data:image/png;base64,AA==",
            },
          ]}
        />
      </ToastProvider>,
    );
    await userEvent.type(
      await screen.findByPlaceholderText(/输入你的想法/),
      "/goal 完成画布首页{Enter}",
    );
    await waitFor(() => expect(createDesignGoalMock).toHaveBeenCalled());

    const composer = screen.getByPlaceholderText(/输入你的想法/);
    await userEvent.type(composer, "用户补充{Enter}");
    await waitFor(() =>
      expect(saveMessageMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        expect.objectContaining({ content: "用户补充" }),
      ),
    );
    expect(saveMessageMock).toHaveBeenCalledWith(
      "token_abc",
      "session-real",
      expect.objectContaining({
        contentBlocks: expect.arrayContaining([
          expect.objectContaining({ type: "image", assetId: "canvas-image-1" }),
        ]),
      }),
    );
    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "用户补充",
          taskId: "session-real",
          inputId: "message-persisted",
          attachments: expect.arrayContaining([
            expect.objectContaining({
              assetId: "canvas-image-1",
              source: "canvas-ref",
            }),
          ]),
        }),
        expect.any(Function),
      ),
    );
    expect(screen.getByText("用户补充")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "持续目标" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始目标" })).toBeNull();

    for (const listener of [...eventListeners]) {
      goalCompleted = true;
      listener(
        {
          type: "run.completed",
          runId: "goal-run",
          timestamp: new Date().toISOString(),
        },
        undefined,
        "session-real",
      );
      listener(
        {
          type: "run.started",
          runId: "run_123",
          sessionId: "session-real",
          conversationId: "session-real",
          timestamp: new Date().toISOString(),
        },
        undefined,
        "session-real",
      );
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "停止本轮" }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
    expect(mockWs.cancelRun).toHaveBeenCalledWith(
      "session-real",
      "run_123",
      expect.any(Function),
    );
  });

  it("persists the stable input ID before CAS-updating Design policy and sending", async () => {
    fetchExecutionModeMock.mockResolvedValue({ mode: "plan" });
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await screen.findByPlaceholderText(/输入你的想法/);
    await userEvent.type(input, "列计划{Enter}");

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());
    expect(updateDesignTaskPolicyMock).toHaveBeenCalledWith(
      "token_abc",
      "session-real",
      {
        expectedScopeGeneration: 2,
        expectedBranchGeneration: 3,
        planEnabled: true,
      },
    );
    expect(saveMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateDesignTaskPolicyMock.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(updateDesignTaskPolicyMock.mock.invocationCallOrder[0]).toBeLessThan(
      (
        mockWs.startRun as unknown as {
          mock: { invocationCallOrder: number[] };
        }
      ).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mockWs.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        inputId: "message-persisted",
        executionMode: "plan",
        scopeGeneration: 3,
        branchGeneration: 3,
      }),
      expect.any(Function),
    );
  });

  it("requires an explicit user action to provision an old Design session", async () => {
    fetchDesignTaskPolicyMock.mockRejectedValue(
      new ApiApplicationErrorMock("session_not_found", "任务尚未配置执行目录"),
    );
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const prepare = await screen.findByRole("button", { name: "准备任务" });
    expect(provisionDesignTaskMock).not.toHaveBeenCalled();
    await userEvent.click(prepare);
    await waitFor(() =>
      expect(provisionDesignTaskMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
      ),
    );
    expect(await screen.findByPlaceholderText(/输入你的想法/)).toBeEnabled();
  });

  it("resolves the real permission option through its Task-bound interaction ID", async () => {
    fetchDesignTaskApprovalsMock.mockResolvedValueOnce({
      approvals: [
        {
          interactionId: "approval-1",
          kind: "permission",
          anchorRowId: 1,
          createdAt: "2026-10-11T00:00:00.000Z",
          payload: {
            kind: "permission",
            toolCallId: "tool-call",
            toolName: "write_file",
            summary: "写入 /workspace/result.txt",
            detail: { path: "/workspace/result.txt" },
            options: [
              { optionId: "allow-once", label: "允许一次", kind: "allowOnce" },
              { optionId: "deny", label: "拒绝", kind: "deny" },
            ],
          },
        },
      ],
    });
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "允许一次" }),
    );
    await waitFor(() =>
      expect(resolveDesignTaskApprovalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        "approval-1",
        { answer: { optionId: "allow-once" } },
      ),
    );
  });

  it("submits plan approval with the original answer content, not the display label", async () => {
    fetchDesignTaskApprovalsMock.mockResolvedValueOnce({
      approvals: [
        {
          interactionId: "plan-approval-1",
          kind: "userInput",
          anchorRowId: 2,
          createdAt: "2026-10-11T00:00:00.000Z",
          payload: {
            kind: "userInput",
            prompt: "Approve the plan?",
            freeText: false,
            toolName: "ExitPlanMode",
            schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
            input: { plan: "# Steps\n1. Implement" },
            questions: [
              {
                question: "Approve this plan?",
                header: "Plan",
                options: [
                  { value: "approve", label: "Approve" },
                  { value: "reject", label: "Reject" },
                ],
              },
            ],
          },
        },
      ],
    });
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const planApproval = await screen.findByRole("region", {
      name: "计划审批",
    });
    expect(planApproval).toHaveTextContent("# Steps");
    expect(planApproval).toHaveTextContent("1. Implement");
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(resolveDesignTaskApprovalMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        "plan-approval-1",
        {
          answer: {
            action: "accept",
            content: {
              answers: { "Approve this plan?": "approve" },
              answer_0: "approve",
              answer: "approve",
            },
          },
        },
      ),
    );
  });

  it("本轮正在跑时给出「停止本轮」入口，点了 cancelRun 的是这一轮的 runId", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    // 未发消息前没有停止键（没有 runId 时的「停止」是假按钮）
    const input = await screen.findByPlaceholderText(/输入你的想法/);
    expect(screen.queryByRole("button", { name: "停止本轮" })).toBeNull();

    await userEvent.type(input, "画画{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());

    const stop = await screen.findByRole("button", { name: "停止本轮" });
    await userEvent.click(stop);
    expect(mockWs.cancelRun).toHaveBeenCalledWith(
      "session-real",
      "run_123",
      expect.any(Function),
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
        <Harness />
      </ToastProvider>,
    );

    // 图层视图：显示图层内容、不渲染对话输入区，但**标签行仍在**（切视图不影响多标签页）
    expect(await screen.findByText("图层列表占位")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/输入你的想法/)).toBeNull();
    expect(
      screen.getByRole("tablist", { name: "打开的对话" }),
    ).toBeInTheDocument();
    // 历史记录/新建对话只在对话视图里（用户要求：不带进别的面板）
    expect(screen.queryByRole("button", { name: "历史记录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
    // 原「Agent 助手」标题已由标签页取代
    expect(screen.queryByText("Agent 助手")).toBeNull();

    // 点「生成文件」→ 切到文件视图
    await userEvent.click(screen.getByRole("button", { name: "生成文件" }));
    expect(await screen.findByText("生成文件占位")).toBeInTheDocument();
    expect(screen.queryByText("图层列表占位")).toBeNull();

    // 点「对话」→ 切回对话视图（新增的回到对话按钮）
    await userEvent.click(screen.getByRole("button", { name: "面板" }));
    expect(
      await screen.findByPlaceholderText(/输入你的想法/),
    ).toBeInTheDocument();
  });

  it("对话视图里显示「打开的对话」标签页，当前会话占一个标签且可关闭", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
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
    expect(
      screen.getByRole("button", { name: /历史记录/ }),
    ).toBeInTheDocument();

    // 标签页是面板的第一行：执行模式排在它下面，不得压在它上面
    const mode = await screen.findByRole("combobox", { name: "模式" });
    const order = tablist.compareDocumentPosition(mode);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 三个视图图标：**空心**（fill=none）且尺寸一致（用户反馈有的大有的小、有的实心）
    for (const name of ["面板", "图层", "生成文件"]) {
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("fill")).toBe("none");
      expect(svg?.getAttribute("class")).toContain("h-4 w-4");
    }
    // 历史记录/新建对话两个图标同样统一为 h-4 w-4
    for (const name of ["历史记录", "新建对话"]) {
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg?.getAttribute("class")).toContain("h-4 w-4");
    }
  });

  it("点「图层」「生成文件」是**多开标签**：标签栏多出对应标签而不是把对话顶掉", async () => {
    function Harness() {
      const [tab, setTab] = useState<SidePanelTab>("chat");
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
        <Harness />
      </ToastProvider>,
    );

    const tablist = await screen.findByRole("tablist", { name: "打开的对话" });
    const before = tablist.querySelectorAll('[role="tab"]').length;

    await userEvent.click(screen.getByRole("button", { name: "图层" }));
    expect(await screen.findByText("图层列表占位")).toBeInTheDocument();
    expect(tablist.querySelectorAll('[role="tab"]').length).toBe(before + 1);
    expect(screen.getByRole("tab", { name: "图层" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // 再点「生成文件」→ 又多一个标签，图层的仍在（多开，不是替换）
    await userEvent.click(screen.getByRole("button", { name: "生成文件" }));
    expect(await screen.findByText("生成文件占位")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "图层" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "生成文件" })).toBeInTheDocument();
  });
});
