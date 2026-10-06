import { expect, it } from "vitest";
import {
  type CodeUiCompletedTurnView,
  type CodeUiConversationState,
  createCodeUiConversation,
} from "./conversation.js";
import type { CodeAdmittedInput } from "./input-intents.js";

function requireRootSnapshot(
  state: CodeUiConversationState,
  sessionId: string,
) {
  const snapshot = state.snapshots.find(
    (entry) => entry.sessionId === sessionId,
  );
  if (!snapshot) throw new Error("测试缺少实际根会话快照");
  return snapshot;
}

function requireCapturedView(state: CodeUiConversationState, turnId: string) {
  const entry = state.completedTurnViews?.find(([id]) => id === turnId);
  if (!entry) throw new Error("测试缺少实际轮次完成视图");
  return entry[1];
}

function requireNestedViewParts(view: CodeUiCompletedTurnView) {
  const selection = view.config.modelSelection;
  if (!selection) throw new Error("测试视图缺少模型选择");
  const options = selection.options;
  if (!options) throw new Error("测试视图缺少模型选项");
  const planItem = view.plan?.items[0];
  if (!planItem) throw new Error("测试视图缺少实际 Todo");
  const contextWindow = view.usage.contextWindow;
  if (!contextWindow) throw new Error("测试视图缺少上下文用量");
  return { selection, options, planItem, contextWindow };
}

function conversationInput(
  sessionId: string,
): Parameters<typeof createCodeUiConversation>[0] {
  return {
    sessionId,
    workspacePath: "/workspace/project",
    config: {
      provider: "zcode",
      model: "initial-model",
      thought: "low",
      followupMode: "queue",
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "initial-model",
        options: { reasoningLevel: "low" },
      },
    },
  };
}

it("完成 A 的实际配置、Todo 与用量可冷恢复，父 B 的新状态不能改写可分叉事实", () => {
  const input: Parameters<typeof createCodeUiConversation>[0] = {
    sessionId: "completed-config-task",
    workspacePath: "/workspace/project",
    config: {
      provider: "zcode",
      model: "initial-model",
      thought: "low",
      followupMode: "queue",
      mode: "build",
      planEnabled: true,
      modelSelection: {
        providerId: "provider",
        modelId: "initial-model",
        options: { reasoningLevel: "low" },
      },
    },
  };
  const started = createCodeUiConversation(input);
  started.startTurn({ runId: "turn-a", commandId: "send-a", text: "执行 A" });

  // 仓库配置/计划操作写入公开导出状态后，用同一恢复入口继续接受真实事件。
  const activeState = started.exportState();
  const activeSnapshot = requireRootSnapshot(activeState, input.sessionId);
  activeSnapshot.config = {
    ...activeSnapshot.config,
    model: "guided-model",
    thought: "high",
    followupMode: "guide",
    mode: "yolo",
    planEnabled: false,
    modelSelection: {
      providerId: "provider",
      modelId: "guided-model",
      options: { reasoningLevel: "high" },
    },
  };
  activeSnapshot.plan = {
    items: [{ id: "todo-a", content: "A 的已完成任务", status: "completed" }],
    updatedAt: 100,
  };
  activeSnapshot.usage.contextWindow = {
    usedTokens: 87,
    maxTokens: 4096,
    autoCompactThresholdTokens: 3000,
  };
  const host = createCodeUiConversation({ ...input, state: activeState });
  host.recordEvent({
    type: "message.delta",
    runId: "turn-a",
    messageId: "answer-a",
    delta: "A 已完成",
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordEvent({
    type: "run.usage",
    runId: "turn-a",
    inputTokens: 20,
    outputTokens: 10,
    runInputTokens: 20,
    runOutputTokens: 10,
    runCachedInputTokens: 4,
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordEvent({
    type: "run.completed",
    runId: "turn-a",
    timestamp: "2026-10-06T00:00:01.000Z",
  });

  const completedView = {
    config: {
      provider: "zcode",
      model: "guided-model",
      thought: "high",
      followupMode: "guide",
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "guided-model",
        options: { reasoningLevel: "high" },
      },
    },
    plan: {
      items: [{ id: "todo-a", content: "A 的已完成任务", status: "completed" }],
      updatedAt: 100,
    },
    usage: {
      contextWindow: {
        usedTokens: 87,
        maxTokens: 4096,
        autoCompactThresholdTokens: 3000,
      },
      cumulative: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
      },
    },
  };
  expect(host.exportState()).toMatchObject({
    completedTurnViews: [["turn-a", completedView]],
  });

  const futureState = host.exportState();
  const futureSnapshot = requireRootSnapshot(futureState, input.sessionId);
  const future = requireNestedViewParts(futureSnapshot);
  futureSnapshot.config.model = "future-model";
  futureSnapshot.config.thought = "low";
  futureSnapshot.config.mode = "build";
  futureSnapshot.config.planEnabled = true;
  future.selection.modelId = "future-model";
  future.options.reasoningLevel = "low";
  future.planItem.content = "B 的未完成任务";
  future.planItem.status = "inProgress";
  future.contextWindow.usedTokens = 777;
  const restored = createCodeUiConversation({ ...input, state: futureState });
  restored.recordEvent({
    type: "run.completed",
    runId: "turn-a",
    timestamp: "2026-10-06T00:00:02.000Z",
  });
  restored.startTurn({ runId: "turn-b", commandId: "send-b", text: "执行 B" });
  restored.recordEvent({
    type: "run.usage",
    runId: "turn-b",
    inputTokens: 70,
    outputTokens: 20,
    runInputTokens: 70,
    runOutputTokens: 20,
    timestamp: "2026-10-06T00:00:02.000Z",
  });
  expect(restored.getSnapshot().config).toMatchObject({
    model: "future-model",
    thought: "low",
    mode: "build",
    planEnabled: true,
    modelSelection: { modelId: "future-model" },
  });
  expect(restored.getSnapshot().plan).toMatchObject({
    items: [{ content: "B 的未完成任务", status: "inProgress" }],
  });
  expect(restored.getSnapshot().usage).toMatchObject({
    contextWindow: { usedTokens: 777 },
    cumulative: { inputTokens: 90, outputTokens: 30, cacheReadTokens: 4 },
  });
  expect(restored.exportState()).toMatchObject({
    completedTurnViews: [["turn-a", completedView]],
  });
  expect(host.exportState()).toMatchObject({
    completedTurnViews: [["turn-a", completedView]],
  });
});

it.each(["run.failed", "run.canceled"] as const)(
  "%s 结束轮次后迟到完成不能制造成功 assistant 或可分叉视图",
  (type) => {
    const input = conversationInput(`interrupted-${type}`);
    const host = createCodeUiConversation(input);
    host.startTurn({ runId: "interrupted", commandId: "send", text: "执行" });
    host.recordEvent({
      type: "message.delta",
      runId: "interrupted",
      messageId: "partial-answer",
      delta: "只有部分进度",
      timestamp: "2026-10-06T00:00:00.000Z",
    });
    host.recordEvent(
      type === "run.failed"
        ? {
            type,
            runId: "interrupted",
            error: { code: "run_failed", message: "模型调用失败" },
            timestamp: "2026-10-06T00:00:01.000Z",
          }
        : {
            type,
            runId: "interrupted",
            timestamp: "2026-10-06T00:00:01.000Z",
          },
    );
    const restored = createCodeUiConversation({
      ...input,
      state: host.exportState(),
    });
    restored.recordEvent({
      type: "run.completed",
      runId: "interrupted",
      timestamp: "2026-10-06T00:00:02.000Z",
    });
    expect(restored.exportState().completedTurnViews).toEqual([]);
    expect(restored.getSnapshot().rows.window).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assistantText",
          text: "只有部分进度",
          state: "interrupted",
        }),
      ]),
    );
    expect(
      restored
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "assistantText" && row.state === "complete",
        ),
    ).toEqual([]);
  },
);

it("公开维护输入的手动压缩成功只保留 compact 标记，不生成 agent 完成事实", () => {
  const host = createCodeUiConversation(conversationInput("compact-task"));
  const compact: CodeAdmittedInput = {
    intent: {
      sourceCommandId: "compact-command",
      queueItemId: "compact-queue-item",
      clientId: "client",
      kind: "compact",
      text: "",
      attachments: [],
      modelSelection: { providerId: "provider", modelId: "initial-model" },
      mode: "build",
      planEnabled: false,
      delivery: { requested: "startNow", admitted: "startNow" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: 100,
    },
    runId: "compact-run",
    modelInvocation: {
      providerId: "provider",
      modelId: "initial-model",
      configRevision: 1,
      body: {},
      inputCapabilities: { image: false, pdf: false },
    },
    scopeGeneration: 1,
    branchGeneration: 1,
    status: "active",
  };
  host.admitInput(compact);
  host.startInput(compact);
  host.recordEvent({
    type: "run.compacted",
    origin: "manual",
    runId: "compact-run",
    keepMessages: 1,
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordEvent({
    type: "run.completed",
    runId: "compact-run",
    operationResult: { kind: "compact", origin: "manual", status: "applied" },
    timestamp: "2026-10-06T00:00:01.000Z",
  });
  expect(host.getSnapshot().control.phase).toBe("completedSuccess");
  expect(host.getSnapshot().rows.window).toEqual([
    expect.objectContaining({
      kind: "timelineMarker",
      marker: { type: "compact", origin: "manual", status: "success" },
    }),
  ]);
  expect(host.exportState().completedTurnViews).toEqual([]);
});

it("子代理的真实成功轮次不进入根可分叉视图，主轮完成只冻结自己的事实", () => {
  const host = createCodeUiConversation(conversationInput("root-task"));
  host.startTurn({ runId: "root-run", commandId: "send", text: "调研" });
  host.registerChildDispatch({
    parentSessionId: "root-task",
    parentRunId: "root-run",
    toolCallId: "child-dispatch",
    childSessionId: "child-task",
    role: "explore",
    title: "独立调研",
    at: 100,
  });
  host.recordChildRunEvent("child-task", {
    type: "message.delta",
    runId: "child-run",
    messageId: "child-answer",
    delta: "子调研完成",
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordChildRunEvent("child-task", {
    type: "run.completed",
    runId: "child-run",
    timestamp: "2026-10-06T00:00:01.000Z",
  });
  expect(host.getSnapshot("child-task").control.phase).toBe("completedSuccess");
  expect(host.getSnapshot("child-task").rows.window).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "assistantText",
        state: "complete",
        text: "子调研完成",
      }),
    ]),
  );
  expect(host.getSnapshot().control.phase).toBe("running");
  expect(host.exportState().completedTurnViews).toEqual([]);

  host.recordEvent({
    type: "message.delta",
    runId: "root-run",
    messageId: "root-answer",
    delta: "主调研完成",
    timestamp: "2026-10-06T00:00:02.000Z",
  });
  host.recordEvent({
    type: "run.completed",
    runId: "root-run",
    timestamp: "2026-10-06T00:00:03.000Z",
  });
  expect(
    host.exportState().completedTurnViews?.map(([turnId]) => turnId),
  ).toEqual(["root-run"]);
});

it("冷恢复隔离传入与导出状态的嵌套引用，外部改写不污染已完成视图", () => {
  const input = conversationInput("restore-alias-task");
  const started = createCodeUiConversation(input);
  started.startTurn({
    runId: "completed-run",
    commandId: "send",
    text: "执行",
  });
  const active = started.exportState();
  const activeSnapshot = requireRootSnapshot(active, input.sessionId);
  activeSnapshot.plan = {
    items: [{ id: "todo", content: "真实完成任务", status: "completed" }],
    updatedAt: 100,
  };
  activeSnapshot.usage.contextWindow = {
    usedTokens: 87,
    maxTokens: 4096,
    autoCompactThresholdTokens: 3000,
  };
  const host = createCodeUiConversation({ ...input, state: active });
  host.recordEvent({
    type: "message.delta",
    runId: "completed-run",
    messageId: "answer",
    delta: "真实完成回答",
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordEvent({
    type: "run.usage",
    runId: "completed-run",
    inputTokens: 20,
    outputTokens: 7,
    runInputTokens: 20,
    runOutputTokens: 7,
    timestamp: "2026-10-06T00:00:00.000Z",
  });
  host.recordEvent({
    type: "run.completed",
    runId: "completed-run",
    timestamp: "2026-10-06T00:00:01.000Z",
  });
  const state = host.exportState();
  const restored = createCodeUiConversation({ ...input, state });
  const suppliedView = requireCapturedView(state, "completed-run");
  const supplied = requireNestedViewParts(suppliedView);
  supplied.options.reasoningLevel = "high";
  supplied.planItem.content = "外部改写任务";
  supplied.contextWindow.usedTokens = 999;
  suppliedView.usage.cumulative.inputTokens = 999;
  const expectedView = {
    config: { modelSelection: { options: { reasoningLevel: "low" } } },
    plan: { items: [{ content: "真实完成任务", status: "completed" }] },
    usage: {
      contextWindow: { usedTokens: 87 },
      cumulative: { inputTokens: 20, outputTokens: 7 },
    },
  };
  expect(restored.exportState()).toMatchObject({
    completedTurnViews: [["completed-run", expectedView]],
  });

  const exportedView = requireCapturedView(
    restored.exportState(),
    "completed-run",
  );
  const exported = requireNestedViewParts(exportedView);
  exported.options.reasoningLevel = "medium";
  exported.planItem.status = "pending";
  exported.contextWindow.usedTokens = 888;
  exportedView.usage.cumulative.outputTokens = 888;
  expect(restored.exportState()).toMatchObject({
    completedTurnViews: [["completed-run", expectedView]],
  });
  expect(host.exportState()).toMatchObject({
    completedTurnViews: [["completed-run", expectedView]],
  });
});
