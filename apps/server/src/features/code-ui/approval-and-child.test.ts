import { expect, it } from "vitest";
import type { ApprovalEvent } from "../permissions/approval-types.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createCodeUiConversation } from "./conversation.js";
import { createUserInputBroker } from "./user-input-broker.js";

function host() {
  const conversation = createCodeUiConversation({
    sessionId: "root",
    workspacePath: "/project",
    config: {
      provider: "p",
      model: "m",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
  });
  conversation.startTurn({
    runId: "parent",
    commandId: "command",
    text: "work",
  });
  return conversation;
}

it("审批先于流工具事件到达时，后到工具row恢复真实pending锚点", async () => {
  const conversation = host();
  const service = createPermissionService();
  service.onEvent((event) => conversation.recordApprovalEvent(event));
  const pending = service.admit({
    preset: "code",
    instanceId: "workspace",
    taskId: "root",
    runId: "parent",
    toolCallId: "write",
    agentId: "main",
    role: "main",
    scopeGeneration: 1,
    branchGeneration: 1,
    mode: "build",
    approvalCeiling: "build",
    toolName: "Write",
    args: { content: "hello" },
    access: "write",
  });
  try {
    conversation.recordEvent({
      type: "tool.started",
      runId: "parent",
      toolCallId: "write",
      toolName: "Write",
      timestamp: "2026-10-03T00:00:00Z",
    });
    const snapshot = conversation.getSnapshot();
    const tool = snapshot.rows.window.find((row) => row.kind === "toolCall")!;
    expect(snapshot.pendingInteractions[0]?.anchorRowId).toBe(tool.rowId);
    expect(tool).toMatchObject({ status: "pendingApproval" });
  } finally {
    await service.cancel(
      { instanceId: "workspace", taskId: "root" },
      "cleanup",
    );
    await pending;
  }
});

it("审批请求进入原pendingInteractions，批准后移除阻塞且保留原工具身份", () => {
  const conversation = host();
  conversation.recordEvent({
    type: "tool.started",
    runId: "parent",
    toolCallId: "write",
    toolName: "Write",
    timestamp: "2026-10-03T00:00:00Z",
  });
  const event: ApprovalEvent = {
    type: "requested",
    identity: {
      instanceId: "workspace",
      taskId: "root",
      runId: "parent",
      toolCallId: "write",
      agentId: "main",
      role: "main",
      scopeGeneration: 1,
      branchGeneration: 1,
    },
    parameterFingerprint: "fingerprint",
    interaction: {
      interactionId: "interaction",
      kind: "permission",
      createdAt: 1,
      anchorRowId: null,
      payload: {
        kind: "permission",
        toolName: "Write",
        toolCallId: "write",
        summary: "write?",
        detail: { content: "hello" },
        options: [
          {
            optionId: "allowOnce",
            label: "一次允许",
            kind: "allowOnce",
            response: { decision: "allow" },
          },
        ],
      },
    },
  };
  conversation.recordApprovalEvent(event);
  expect(conversation.getSnapshot().pendingInteractions).toMatchObject([
    { interactionId: "interaction", payload: { toolCallId: "parent/write" } },
  ]);
  expect(
    conversation
      .getSnapshot()
      .rows.window.find((row) => row.kind === "toolCall"),
  ).toMatchObject({ status: "pendingApproval" });
  conversation.recordApprovalEvent({
    ...event,
    type: "resolved",
    decision: "allow",
  });
  expect(conversation.getSnapshot().pendingInteractions).toEqual([]);
  expect(
    conversation
      .getSnapshot()
      .rows.window.find((row) => row.kind === "toolCall"),
  ).toMatchObject({ status: "running", toolCallId: "parent/write" });
});

it("父Run停止保留detached子转录，foreground子收到取消", () => {
  const conversation = host();
  for (const [id, detached] of [
    ["background", true],
    ["foreground", false],
  ] as const)
    conversation.registerChildDispatch({
      parentSessionId: "root",
      parentRunId: "parent",
      toolCallId: id,
      childSessionId: id,
      role: "explore",
      title: id,
      at: 1,
      detached,
    });
  conversation.recordEvent({
    type: "run.canceled",
    runId: "parent",
    timestamp: "2026-10-03T00:00:00Z",
  });
  expect(conversation.getSnapshot("background").control.phase).toBe("running");
  expect(conversation.getSnapshot("foreground").control.phase).toBe(
    "completedInterrupted",
  );
  expect(
    conversation
      .getSnapshot()
      .subagents?.running.map((child) => child.childSessionId),
  ).toEqual(["background"]);
});

it("独立子Run正文不进入父转录，父终态后仍可持久投影detached结果", () => {
  const conversation = host();
  conversation.registerChildDispatch({
    parentSessionId: "root",
    parentRunId: "parent",
    toolCallId: "task",
    childSessionId: "child",
    role: "explore",
    title: "research",
    at: 1,
    detached: true,
  });
  conversation.recordEvent({
    type: "run.completed",
    runId: "parent",
    timestamp: "2026-10-03T00:00:00Z",
  });
  conversation.recordChildRunEvent("child", {
    type: "message.delta",
    runId: "child-run",
    messageId: "m",
    delta: "child evidence",
    timestamp: "2026-10-03T00:00:01Z",
  });
  conversation.recordChildRunEvent("child", {
    type: "run.completed",
    runId: "child-run",
    timestamp: "2026-10-03T00:00:02Z",
  });
  const restored = createCodeUiConversation({
    sessionId: "root",
    workspacePath: "/project",
    config: conversation.getSnapshot().config,
    state: conversation.exportState(),
  });
  expect(
    restored
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText"),
  ).toEqual([]);
  expect(
    restored
      .getSnapshot("child")
      .rows.window.find((row) => row.kind === "assistantText"),
  ).toMatchObject({ text: "child evidence", state: "complete" });
  expect(
    restored.getSnapshot().rows.window.find((row) => row.kind === "subagent"),
  ).toMatchObject({ status: "success", summaryText: "child evidence" });
});

it("子运行未能持久写终态时，Task工作终态关闭子卡片并拒绝迟到正文", () => {
  const conversation = host();
  conversation.registerChildDispatch({
    parentSessionId: "root",
    parentRunId: "parent",
    toolCallId: "task",
    childSessionId: "child",
    role: "explore",
    title: "research",
    at: 1,
    detached: false,
  });
  conversation.recordEvent({
    type: "task.work",
    runId: "parent",
    timestamp: "2026-10-03T00:00:03Z",
    work: {
      workId: "work",
      taskId: "root",
      branchGeneration: 1,
      originRunId: "parent",
      toolCallId: "task",
      kind: "subagent",
      label: "research",
      status: "failed",
      startedAt: "2026-10-03T00:00:00Z",
      endedAt: "2026-10-03T00:00:03Z",
      childSessionId: "child",
      summary: "event persistence failed",
      consumed: true,
      detached: false,
    },
  });
  expect(
    conversation
      .getSnapshot()
      .rows.window.find((row) => row.kind === "subagent"),
  ).toMatchObject({
    status: "failed",
    summaryText: "event persistence failed",
  });
  expect(conversation.getSnapshot("child").control.phase).toBe("error");
  conversation.recordChildRunEvent("child", {
    type: "message.delta",
    runId: "late",
    messageId: "late",
    delta: "late content",
    timestamp: "2026-10-03T00:00:04Z",
  });
  expect(
    conversation
      .getSnapshot("child")
      .rows.window.some((row) => row.kind === "assistantText"),
  ).toBe(false);
});

it("重建转录后Task工作中断清掉子Ask等待和工具，随后父取消不留下无法回答的问题", async () => {
  const conversation = host();
  conversation.registerChildDispatch({
    parentSessionId: "root",
    parentRunId: "parent",
    toolCallId: "task",
    childSessionId: "child",
    role: "explore",
    title: "research",
    at: 1,
    detached: true,
  });
  conversation.recordChildRunEvent("child", {
    type: "tool.started",
    runId: "child-run",
    toolCallId: "ask-child",
    toolName: "AskUserQuestion",
    timestamp: "2026-10-03T00:00:01Z",
  });
  const broker = createUserInputBroker();
  const controller = new AbortController();
  let published!: () => void;
  const publication = new Promise<void>((resolve) => {
    published = resolve;
  });
  const unsubscribe = broker.onEvent((event) => {
    conversation.recordInteractionEvent(event);
    if (event.type === "requested") published();
  });
  const request = broker.request({
    preset: "code",
    instanceId: "workspace",
    taskId: "root",
    runId: "child-run",
    toolCallId: "ask-child",
    agentId: "child",
    role: "explore",
    scopeGeneration: 1,
    branchGeneration: 1,
    mode: "build",
    approvalCeiling: "build",
    toolName: "AskUserQuestion",
    access: "read",
    signal: controller.signal,
    args: {
      questions: [
        {
          question: "选择调研来源？",
          header: "来源",
          options: [
            { label: "官方源码", description: "追踪实际实现" },
            { label: "官方文档", description: "核对公开契约" },
          ],
          multiSelect: false,
        },
      ],
    },
  });
  const outcome = request.catch(() => undefined);
  try {
    await Promise.race([
      publication,
      outcome.then(() => {
        throw new Error("子问题发布前调用已结束");
      }),
    ]);
    expect(conversation.getSnapshot("child").pendingInteractions).toHaveLength(
      1,
    );
    const restored = createCodeUiConversation({
      sessionId: "root",
      workspacePath: "/project",
      config: conversation.getSnapshot().config,
      state: conversation.exportState(),
    });
    restored.recordEvent({
      type: "task.work",
      runId: "parent",
      timestamp: "2026-10-03T00:00:03Z",
      work: {
        workId: "work",
        taskId: "root",
        branchGeneration: 1,
        originRunId: "parent",
        toolCallId: "task",
        kind: "subagent",
        label: "research",
        status: "interrupted",
        startedAt: "2026-10-03T00:00:00Z",
        endedAt: "2026-10-03T00:00:03Z",
        childSessionId: "child",
        summary: "宿主重启",
        consumed: true,
        detached: true,
      },
    });
    restored.recordEvent({
      type: "run.canceled",
      runId: "parent",
      timestamp: "2026-10-03T00:00:04Z",
    });
    const child = restored.getSnapshot("child");
    expect(child.control).toMatchObject({
      phase: "completedInterrupted",
      activeWorks: [],
      canStop: false,
    });
    expect(child.pendingInteractions).toEqual([]);
    expect(
      child.rows.window.filter((row) => row.kind === "toolCall"),
    ).toMatchObject([
      { toolCallId: "child-run/ask-child", status: "cancelled" },
    ]);
  } finally {
    await broker.close("test cleanup");
    await outcome;
    unsubscribe();
  }
});
