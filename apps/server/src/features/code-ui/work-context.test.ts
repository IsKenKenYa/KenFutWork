import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { resolvePresetForRun } from "../../agent/runtime.js";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { claimGoalContinuation } from "./goal-admission.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";
import {
  contributionsForRun,
  freezeWorkContext,
  latestWorkContext,
  workContextForRun,
} from "./work-context.js";

const taskId = "00000000-0000-4000-8000-000000000003";
const projectId = "00000000-0000-4000-8000-000000000002";
const instanceId = "00000000-0000-4000-8000-000000000001";
const config = {
  provider: "zcode",
  model: "test",
  thought: "",
  followupMode: "queue" as const,
};
function root(state: CodeUiSessionRecord["state"]): CodeUiSessionRecord {
  return {
    id: taskId,
    instance_id: instanceId,
    project_id: projectId,
    root_directory: "/workspace",
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: taskId,
    root_session_id: taskId,
    parent_session_id: null,
    parent_tool_call_id: null,
    state,
    revision: 0,
    active_run_id: null,
    archived: false,
    pinned: false,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    deleted_at: null,
  };
}

describe("共享Task的工作上下文", () => {
  it("上下文是深拷贝，画布引用和选区不改文件授权，选区不能缺失画布", () => {
    const source: protocol.ConversationWorkContext = {
      preset: "design",
      canvasId: "canvas",
      selectedCanvasElements: [{ id: "element", customData: { version: 1 } }],
      videoGenerationPreference: { mode: "manual", models: ["video"] },
    };
    const frozen = freezeWorkContext(source);
    source.canvasId = "changed";
    source.selectedCanvasElements![0]!.customData = { version: 2 };
    source.videoGenerationPreference!.models.push("new");
    expect(frozen).toEqual({
      preset: "design",
      canvasId: "canvas",
      selectedCanvasElements: [{ id: "element", customData: { version: 1 } }],
      videoGenerationPreference: { mode: "manual", models: ["video"] },
    });
    expect(() =>
      freezeWorkContext({
        preset: "design",
        selectedCanvasElements: [{ id: "element" }],
      }),
    ).toThrow();
    expect(() =>
      protocol.conversationWorkContextSchema.parse({
        preset: "design",
        canvasId: "canvas",
        rootDirectory: "/escape",
      }),
    ).toThrow();
  });

  it("冷读保留各Run固定方式，同一历史聚合投影所有用过的方式", () => {
    const host = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
    });
    host.startTurn({
      runId: "code-run",
      commandId: "first",
      text: "读取文件",
      workContext: { preset: "code" },
    });
    host.recordEvent({
      type: "run.completed",
      runId: "code-run",
      timestamp: "2026-10-15T00:00:00Z",
    });
    host.startTurn({
      runId: "design-run",
      commandId: "second",
      text: "绘制",
      workContext: { preset: "design", canvasId: "canvas-a" },
    });
    const reopened = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
      state: host.exportState(),
    });
    expect(workContextForRun(reopened.exportState(), "code-run")).toEqual({
      preset: "code",
    });
    expect(workContextForRun(reopened.exportState(), "design-run")).toEqual({
      preset: "design",
      canvasId: "canvas-a",
    });
    expect(
      codeUiTaskMeta(root(reopened.exportState()), "/workspace"),
    ).toMatchObject({ taskId, workModes: ["code", "design"] });
    expect(
      reopened
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["读取文件", "绘制"]);
  });

  it("Code预热不算使用；仅有Design实际Run的会话只进入Design筛选，旧Code缺声明才回退", () => {
    const host = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
    });
    expect(codeUiTaskMeta(root(host.exportState()), "/workspace")).toBeNull();
    host.startTurn({
      runId: "design-only",
      commandId: "first",
      text: "绘制",
      workContext: { preset: "design" },
    });
    const state = host.exportState();
    expect(state.initialWorkContext).toEqual({ preset: "code" });
    expect(codeUiTaskMeta(root(state), "/workspace")?.workModes).toEqual([
      "design",
    ]);
    const legacy = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
    });
    legacy.startTurn({
      runId: "old-code",
      commandId: "old-send",
      text: "旧编码对话",
    });
    const oldState = legacy.exportState();
    delete oldState.initialWorkContext;
    delete oldState.runWorkContexts;
    expect(codeUiTaskMeta(root(oldState), "/workspace")?.workModes).toEqual([
      "code",
    ]);
  });

  it("Run工作方式来自可信冻结上下文，不能靠画布或UI声明改变Task文件身份", () => {
    const handle = { preset: "code" as const };
    expect(
      resolvePresetForRun({
        scopeHandle: handle,
        preset: "design",
        canvasId: "canvas",
      }),
    ).toBe("code");
    expect(
      resolvePresetForRun({
        scopeHandle: handle,
        preset: "code",
        workContext: { preset: "design", canvasId: "canvas" },
      }),
    ).toBe("design");
    expect(handle.preset).toBe("code");
  });

  it("独立子Run的冻结上下文进入同一根聚合，父结束后后台子仍保持原画布及自身Run身份", () => {
    const context: protocol.ConversationWorkContext = {
      preset: "design",
      canvasId: "canvas-original",
    };
    const host = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
      workContext: context,
    });
    host.startTurn({
      runId: "parent-run",
      commandId: "parent-send",
      text: "派发",
      workContext: context,
    });
    host.registerChildDispatch({
      parentSessionId: taskId,
      parentRunId: "parent-run",
      toolCallId: "call",
      childSessionId: "child",
      role: "explore",
      title: "只读画布",
      at: 0,
      detached: true,
    });
    host.recordChildRunEvent(
      "child",
      {
        type: "tool.started",
        runId: "child-run",
        toolCallId: "read",
        toolName: "inspect_canvas",
        timestamp: "2026-10-15T00:00:00Z",
      },
      context,
    );
    host.recordEvent({
      type: "run.completed",
      runId: "parent-run",
      timestamp: "2026-10-15T00:00:01Z",
    });
    const cold = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
      state: host.exportState(),
    });
    expect(workContextForRun(cold.exportState(), "child-run")).toEqual(context);
    expect(cold.getSnapshot("child").control).toMatchObject({
      phase: "running",
      activeWorks: [{ foregroundExecutionId: "child-run" }],
    });
    expect(cold.getSnapshot().control.phase).toBe("completedSuccess");
    cold.startTurn({
      runId: "next-parent",
      commandId: "next-send",
      text: "处理文件",
      workContext: { preset: "code" },
    });
    cold.recordChildRunEvent(
      "child",
      {
        type: "run.completed",
        runId: "child-run",
        timestamp: "2026-10-15T00:00:02Z",
      },
      context,
    );
    expect(cold.getSnapshot("child").control.phase).toBe("completedSuccess");
    expect(latestWorkContext(cold.exportState())).toEqual({ preset: "code" });
    expect(cold.getSnapshot().control.phase).toBe("running");
    expect(workContextForRun(cold.exportState(), "parent-run")).toEqual(
      context,
    );
  });

  it("旧Code缺省保留code；Goal续轮保留创建时文档上下文而不采用界面当前目标", () => {
    const goals = createGoalService();
    const host = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
      goals,
    });
    const goal = goals.create(null, {
      goalId: "goal",
      objective: "完成画布",
      branchGeneration: 1,
      at: 0,
    });
    host.setGoal(goal, {
      goalId: "goal",
      selection: { providerId: "provider", modelId: "test" },
      invocation: {
        providerId: "provider",
        modelId: "test",
        configRevision: 1,
        body: {},
        inputCapabilities: { image: false, pdf: false },
      },
      workContext: { preset: "design", canvasId: "canvas-original" },
    });
    expect(workContextForRun(host.exportState(), "legacy-run")).toEqual({
      preset: "code",
    });
    const legacyState = host.exportState();
    Object.assign(legacyState.goalModel!, {
      frozenContributions: {
        version: 1,
        preset: "design",
        entries: [{ kind: "dynamic", id: "retired-tool", signature: "old" }],
      },
    });
    const cold = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: "/workspace",
      config,
      state: legacyState,
    });
    expect(cold.exportState().goalModel).not.toHaveProperty(
      "frozenContributions",
    );
    const currentCapabilities = {
      version: 1 as const,
      preset: "design" as const,
      entries: [
        { kind: "dynamic" as const, id: "new-tool", signature: "current" },
      ],
    };
    const decision = claimGoalContinuation(
      root(cold.exportState()),
      {
        goalId: "goal",
        revision: 1,
        runId: "goal-run",
        commandId: "goal-continue",
        text: "继续",
        owner: { hostId: "host", runtimeId: "runtime" },
        at: 1,
        frozenContributions: currentCapabilities,
      },
      goals,
    );
    expect(workContextForRun(decision.state, "goal-run")).toEqual({
      preset: "design",
      canvasId: "canvas-original",
    });
    expect(decision.state.goalRecord).toMatchObject({
      goalId: "goal",
      claimedRunId: "goal-run",
    });
    expect(contributionsForRun(decision.state, "goal-run")).toEqual(
      currentCapabilities,
    );
  });
});
