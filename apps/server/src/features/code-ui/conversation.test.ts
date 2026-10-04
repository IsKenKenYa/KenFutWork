import { describe, expect, it } from "vitest";
import { createCodeUiConversation } from "./conversation.js";

it("共同Harness的真实run.compacted投影为自动压缩标记，不伪造用户行或实际token数", () => {
  const host = createCodeUiConversation({ sessionId: "root", workspacePath: "/project", config: { provider: "zcode", model: "test", thought: "", followupMode: "queue" } });
  host.startTurn({ runId: "run", commandId: "send", text: "研究" });
  host.recordEvent({ type: "run.compacted", runId: "run", triggerTokens: 4096, triggerSource: "reserved-output", keepMessages: 20, timestamp: "2026-10-03T00:00:00Z" });
  const snapshot = host.getSnapshot();
  expect(snapshot.rows.window.filter((row) => row.kind === "userInput")).toHaveLength(1);
  const marker = snapshot.rows.window.find((row) => row.kind === "timelineMarker");
  expect(marker).toMatchObject({ lane: "assistantWork", marker: { type: "compact", origin: "auto", status: "success" } });
  expect(marker?.kind === "timelineMarker" ? marker.marker : {}).not.toHaveProperty("tokensBefore");
});

describe("Code 宿主会话快照", () => {
  it("原sendText的完整模型选项持久到Task快照，恢复后追问沿用同一选择", () => {
    const selection = { providerId: "provider", modelId: "model", options: { reasoningLevel: "low" } };
    const host = createCodeUiConversation({ sessionId: "selected-task", workspacePath: "/work", config: { provider: "zcode", model: "model", thought: "", followupMode: "queue", mode: "build" } });
    host.startTurn({ runId: "run", commandId: "command", text: "执行", modelSelection: selection });
    const restored = createCodeUiConversation({ sessionId: "selected-task", workspacePath: "/work", config: host.getSnapshot().config, state: host.exportState() });
    expect(restored.getSnapshot().config.modelSelection).toEqual(selection);
    selection.options.reasoningLevel = "high";
    expect(restored.getSnapshot().config.modelSelection?.options?.reasoningLevel).toBe("low");
  });
  it("真实文件工具的chip保留实际绝对路径，运行事实原参数保持完整", () => {
    const host = createCodeUiConversation({
      sessionId: "root-file-path",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    host.startTurn({
      runId: "run-file-path",
      commandId: "command-file-path",
      text: "读取",
    });
    const event = {
      type: "tool.started" as const,
      runId: "run-file-path",
      toolCallId: "read",
      toolName: "Read",
      input: { file_path: "/workspace/project/例子.ts", offset: 0 },
      timestamp: "2026-10-02T12:00:00.000Z",
    };
    host.recordEvent(event);
    expect(
      host.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      input: { file_path: "/workspace/project/例子.ts", offset: 0 },
    });
    expect(event.input).toEqual({
      file_path: "/workspace/project/例子.ts",
      offset: 0,
    });
  });
  it("运行失败保留可读原因，停止工具与正文并拒绝迟到结果", () => {
    const host = createCodeUiConversation({
      sessionId: "root-error",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-error",
      commandId: "command-error",
      text: "检查",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-error",
      toolCallId: "read",
      toolName: "read_file",
      timestamp,
    });
    host.recordEvent({
      type: "run.failed",
      runId: "run-error",
      error: { code: "run_failed", message: "模型网关拒绝请求" },
      timestamp,
    });
    host.recordEvent({
      type: "tool.completed",
      runId: "run-error",
      toolCallId: "read",
      toolName: "read_file",
      outputText: "迟到结果",
      timestamp,
    });
    expect(host.getSnapshot().control).toMatchObject({
      phase: "error",
      canStop: false,
      lastError: { message: "模型网关拒绝请求" },
    });
    expect(
      host.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({ status: "cancelled" });
  });
  it("真实运行的思考与正文各自结束，完成后的迟到正文不能续写", () => {
    const host = createCodeUiConversation({
      sessionId: "root-complete",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-complete",
      commandId: "command-complete",
      text: "检查",
    });
    host.recordEvent({
      type: "thinking.delta",
      runId: "run-complete",
      messageId: "response",
      delta: "先读取。",
      timestamp,
    });
    host.recordEvent({
      type: "message.delta",
      runId: "run-complete",
      messageId: "response",
      delta: "完成。",
      timestamp,
    });
    host.recordEvent({
      type: "run.completed",
      runId: "run-complete",
      timestamp,
    });
    host.recordEvent({
      type: "message.delta",
      runId: "run-complete",
      messageId: "response",
      delta: "迟到。",
      timestamp,
    });
    const snapshot = host.getSnapshot();
    expect(snapshot.control).toMatchObject({
      phase: "completedSuccess",
      canStop: false,
      sessionEnded: true,
    });
    expect(
      snapshot.rows.window
        .filter(
          (row) => row.kind === "reasoning" || row.kind === "assistantText",
        )
        .map((row) => ({ kind: row.kind, text: row.text, state: row.state })),
    ).toEqual([
      { kind: "reasoning", text: "先读取。", state: "complete" },
      { kind: "assistantText", text: "完成。", state: "complete" },
    ]);
  });
  it("父 Agent 行关联独立子会话，子正文不进入主会话", () => {
    const host = createCodeUiConversation({
      sessionId: "root-session",
      workspacePath: "/workspace/code-project",
      clock: () => Date.parse("2026-10-02T12:00:00.000Z"),
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    host.startTurn({
      runId: "run-1",
      commandId: "command-1",
      text: "调研代码",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-1",
      toolCallId: "dispatch-1",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "分析目录" },
      timestamp: "2026-10-02T12:00:00.000Z",
    });
    const subagent = host
      .getSnapshot()
      .rows.window.find((row) => row.kind === "subagent");
    if (subagent?.kind !== "subagent" || !subagent.childSessionId)
      throw new Error("缺少原子会话身份");
    host.recordEvent({
      type: "message.delta",
      runId: "run-1",
      messageId: "child-message-1",
      delta: "仅属于子代理。",
      agentCallId: "dispatch-1",
      agentName: "explore",
      timestamp: "2026-10-02T12:00:01.000Z",
    });

    expect({
      parentText: host
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "assistantText")
        .map((row) => row.text),
      childText: host
        .getSnapshot(subagent.childSessionId)
        .rows.window.filter((row) => row.kind === "assistantText")
        .map((row) => row.text),
    }).toEqual({ parentText: [], childText: ["仅属于子代理。"] });
  });

  it("重放同一次派发不会生成第二个子会话或目录条目", () => {
    const host = createCodeUiConversation({
      sessionId: "root-replay",
      workspacePath: "/workspace/code-project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    host.startTurn({
      runId: "run-replay",
      commandId: "command-replay",
      text: "调研",
    });
    const event = {
      type: "tool.started" as const,
      runId: "run-replay",
      toolCallId: "call-replay",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "读取" },
      timestamp: "2026-10-02T12:00:00.000Z",
    };
    host.recordEvent(event);
    host.recordEvent(event);

    expect(host.getSnapshot().subagents?.childSessionIds).toHaveLength(1);
  });

  it("子会话工具终态保留完整正文和失败状态，供主/子同一 renderer 读取", () => {
    const host = createCodeUiConversation({
      sessionId: "root-tool",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-tool",
      commandId: "command-tool",
      text: "调研",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-tool",
      toolCallId: "dispatch-tool",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "检查" },
      timestamp,
    });
    const childId = host.getSnapshot().subagents?.childSessionIds[0];
    if (!childId) throw new Error("缺少子会话");
    host.recordEvent({
      type: "tool.started",
      runId: "run-tool",
      toolCallId: "read-child",
      toolName: "read_file",
      input: { path: "/a.ts" },
      agentCallId: "dispatch-tool",
      timestamp,
    });
    host.recordEvent({
      type: "tool.completed",
      runId: "run-tool",
      toolCallId: "read-child",
      toolName: "read_file",
      outputText: "读取失败：文件不存在",
      status: "error",
      agentCallId: "dispatch-tool",
      timestamp,
    });
    const row = host
      .getSnapshot(childId)
      .rows.window.find((row) => row.kind === "toolCall");

    expect(row).toMatchObject({
      status: "error",
      output: { text: "读取失败：文件不存在" },
      error: { message: "读取失败：文件不存在" },
    });
  });

  it("前台派发结束后关闭子会话运行态，保留其正文并更新目录终态", () => {
    const host = createCodeUiConversation({
      sessionId: "root-end",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-end",
      commandId: "command-end",
      text: "检查",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-end",
      toolCallId: "dispatch-end",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "检查目录" },
      timestamp,
    });
    const childId = host.getSnapshot().subagents?.childSessionIds[0];
    if (!childId) throw new Error("缺少子会话");
    host.recordEvent({
      type: "message.delta",
      runId: "run-end",
      messageId: "child-end",
      delta: "检查完成。",
      agentCallId: "dispatch-end",
      timestamp,
    });
    host.recordEvent({
      type: "tool.completed",
      runId: "run-end",
      toolCallId: "dispatch-end",
      toolName: "subagent_task",
      outputText: "检查完成。",
      status: "success",
      timestamp,
    });

    expect({
      phase: host.getSnapshot(childId).control.phase,
      running: host.getSnapshot().subagents?.running.length,
      ended: host.getSnapshot().subagents?.endedTotal,
    }).toEqual({ phase: "completedSuccess", running: 0, ended: 1 });
  });

  it("宿主恢复后沿用子会话身份与转录，不重新生成目录或展示投影", () => {
    const input = {
      sessionId: "root-restore",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue" as const,
        mode: "build",
      },
    };
    const host = createCodeUiConversation(input);
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-restore",
      commandId: "command-restore",
      text: "检查",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-restore",
      toolCallId: "dispatch-restore",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "检查目录" },
      timestamp,
    });
    const childId = host.getSnapshot().subagents?.childSessionIds[0];
    if (!childId) throw new Error("缺少子会话");
    host.recordEvent({
      type: "message.delta",
      runId: "run-restore",
      messageId: "child-restore",
      delta: "恢复后仍可读取。",
      agentCallId: "dispatch-restore",
      timestamp,
    });
    const restored = createCodeUiConversation({
      ...input,
      state: host.exportState(),
    });

    expect(restored.getSnapshot(childId)).toEqual(host.getSnapshot(childId));
  });

  it("取消关闭主/子运行态，迟到的子正文不能复活或续写已结束转录", () => {
    const host = createCodeUiConversation({
      sessionId: "root-cancel",
      workspacePath: "/workspace/project",
      config: {
        provider: "zcode",
        model: "glm-4.5-air",
        thought: "",
        followupMode: "queue",
        mode: "build",
      },
    });
    const timestamp = "2026-10-02T12:00:00.000Z";
    host.startTurn({
      runId: "run-cancel",
      commandId: "command-cancel",
      text: "检查",
    });
    host.recordEvent({
      type: "tool.started",
      runId: "run-cancel",
      toolCallId: "dispatch-cancel",
      toolName: "subagent_task",
      input: { subagent_type: "explore", description: "检查目录" },
      timestamp,
    });
    const childId = host.getSnapshot().subagents?.childSessionIds[0];
    if (!childId) throw new Error("缺少子会话");
    host.recordEvent({
      type: "message.delta",
      runId: "run-cancel",
      messageId: "child-cancel",
      delta: "已有进度。",
      agentCallId: "dispatch-cancel",
      timestamp,
    });
    host.recordEvent({ type: "run.canceled", runId: "run-cancel", timestamp });
    host.recordEvent({
      type: "message.delta",
      runId: "run-cancel",
      messageId: "child-cancel",
      delta: "迟到正文。",
      agentCallId: "dispatch-cancel",
      timestamp,
    });

    expect({
      root: host.getSnapshot().control.phase,
      child: host.getSnapshot(childId).control.phase,
      text: host
        .getSnapshot(childId)
        .rows.window.filter((row) => row.kind === "assistantText")
        .map((row) => row.text),
    }).toEqual({
      root: "completedInterrupted",
      child: "completedInterrupted",
      text: ["已有进度。"],
    });
  });
});
