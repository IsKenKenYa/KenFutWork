import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { buildRunTimeline, mergeChildEvents } from "./timeline.js";
import type { RunTimelineEventRow, RunTimelineRunRow } from "./types.js";

const RUN_ID = "run-1";
const ROOT_SESSION_ID = "session-1";
const T0 = "2026-11-04T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1_000).toISOString();
}

function run(overrides: Partial<RunTimelineRunRow> = {}): RunTimelineRunRow {
  return {
    runId: RUN_ID,
    rootSessionId: ROOT_SESSION_ID,
    model: "model-x",
    status: "completed",
    stopReason: "completed",
    errorCode: null,
    errorMessage: null,
    startedAt: T0,
    completedAt: at(65),
    ...overrides,
  };
}

function rows(...events: StreamEvent[]): RunTimelineEventRow[] {
  return events.map((event, index) => ({
    seq: index + 1,
    createdAt: event.timestamp,
    event,
  }));
}

function startedTool(input?: Record<string, unknown>): StreamEvent {
  return {
    type: "tool.started",
    runId: RUN_ID,
    toolCallId: "call-1",
    toolName: "Read",
    ...(input ? { input } : {}),
    timestamp: T0,
  };
}

function completedTool(
  overrides: Partial<Extract<StreamEvent, { type: "tool.completed" }>> = {},
): StreamEvent {
  return {
    type: "tool.completed",
    runId: RUN_ID,
    toolCallId: "call-1",
    toolName: "Read",
    status: "success",
    outputSummary: "读取 120 行",
    timestamp: at(2),
    ...overrides,
  };
}

describe("buildRunTimeline", () => {
  it("把同一工具调用的开始与完成合并成一条，并计算耗时", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(startedTool({ file_path: "src/a.ts" }), completedTool()),
      usage: null,
    });

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      kind: "tool",
      title: "Read",
      name: "Read",
      status: "success",
      durationMs: 2_000,
      detail: "读取 120 行",
    });
  });

  it("完成到达但缺少开始事件时仍生成条目，并以终态时间为准", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(completedTool({ timestamp: at(3) })),
      usage: null,
    });

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      kind: "tool",
      at: at(3),
      status: "success",
    });
    expect(timeline.entries[0]?.durationMs).toBeUndefined();
  });

  it("只有开始事件时保留进行中状态", () => {
    const timeline = buildRunTimeline({
      run: run({ status: "running", completedAt: null }),
      events: rows(startedTool({ command: "pnpm test" })),
      usage: null,
    });

    expect(timeline.entries[0]).toMatchObject({
      kind: "tool",
      status: "running",
      detail: "pnpm test",
    });
  });

  it("子代理内部调用按 agentCallId 分组并带出 agentName", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "tool.started",
          runId: RUN_ID,
          toolCallId: "call-1",
          toolName: "Read",
          agentName: "explorer",
          agentCallId: "dispatch-1",
          timestamp: T0,
        },
        {
          type: "tool.completed",
          runId: RUN_ID,
          toolCallId: "call-1",
          toolName: "Read",
          status: "error",
          agentName: "explorer",
          agentCallId: "dispatch-1",
          timestamp: at(1),
        },
        // 主 agent 的同名 toolCallId 不应被子代理的终态关掉
        startedTool(),
      ),
      usage: null,
    });

    expect(timeline.entries).toHaveLength(2);
    expect(timeline.entries[0]).toMatchObject({
      kind: "tool",
      status: "error",
      agentName: "explorer",
    });
    expect(timeline.entries[1]).toMatchObject({ status: "running" });
  });

  it("重复的开始事件不会互相覆盖终态", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(startedTool(), startedTool(), completedTool()),
      usage: null,
    });

    expect(timeline.entries).toHaveLength(2);
    expect(timeline.entries[0]?.status).toBe("running");
    expect(timeline.entries[1]?.status).toBe("success");
  });

  it("运行开始、完成、停止、失败与重试各有对应条目", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "run.started",
          runId: RUN_ID,
          sessionId: "session-1",
          conversationId: "conversation-1",
          timestamp: T0,
        },
        {
          type: "run.retrying",
          runId: RUN_ID,
          attempt: 2,
          maxAttempts: 3,
          reason: "上游 429",
          timestamp: at(1),
        },
        { type: "run.completed", runId: RUN_ID, timestamp: at(2) },
        {
          type: "run.canceled",
          runId: RUN_ID,
          stopReason: "user_cancelled",
          timestamp: at(3),
        },
        {
          type: "run.failed",
          runId: RUN_ID,
          error: { code: "run_failed", message: "上游拒绝" },
          timestamp: at(4),
        },
      ),
      usage: null,
    });

    expect(timeline.entries.map((entry) => entry.kind)).toEqual([
      "run",
      "retry",
      "run",
      "run",
      "run",
    ]);
    expect(timeline.entries[1]).toMatchObject({
      title: "第 2 次尝试（共 3 次）",
      detail: "上游 429",
    });
    expect(timeline.entries[3]).toMatchObject({
      title: "运行已停止",
      status: "cancelled",
      detail: "用户停止",
    });
    expect(timeline.entries[4]).toMatchObject({
      kind: "run",
      status: "error",
      name: "run_failed",
      detail: "上游拒绝",
    });
  });

  it("自动压缩写出触发线来源，手动压缩写出未生效原因", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "run.compacted",
          runId: RUN_ID,
          origin: "auto",
          triggerTokens: 170_000,
          triggerSource: "fallback",
          keepMessages: 20,
          timestamp: T0,
        },
        {
          type: "run.completed",
          runId: RUN_ID,
          operationResult: {
            kind: "compact",
            origin: "manual",
            status: "unchanged",
            reason: "insufficient_history",
          },
          timestamp: at(1),
        },
      ),
      usage: null,
    });

    expect(timeline.entries[0]).toMatchObject({
      kind: "compaction",
      detail: "自动压缩 · 保留最近 20 条消息 · 兜底阈值",
    });
    expect(timeline.entries[1]?.detail).toBe("手动压缩未生效（历史不足）");
  });

  it("钩子按退出码与超时判定状态", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows({
        type: "run.hook",
        runId: RUN_ID,
        event: "turn-start",
        command: "echo hi",
        exitCode: null,
        timedOut: true,
        output: "",
        durationMs: 30_000,
        timestamp: T0,
      }),
      usage: null,
    });

    expect(timeline.entries[0]).toMatchObject({
      kind: "hook",
      title: "钩子 · 回合开始",
      name: "turn-start",
      status: "error",
      durationMs: 30_000,
    });
    expect(timeline.entries[0]?.detail).toBeUndefined();
  });

  it("工具失败钩子按事件名标签展示", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows({
        type: "run.hook",
        runId: RUN_ID,
        event: "tool-failed",
        command: "false",
        exitCode: 1,
        timedOut: false,
        output: "boom",
        durationMs: 2,
        timestamp: T0,
      }),
      usage: null,
    });

    expect(timeline.entries[0]).toMatchObject({
      kind: "hook",
      title: "钩子 · 工具失败",
      name: "tool-failed",
      status: "error",
    });
  });

  it("后台子代理与后台命令的结算通知各归一类", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "task.notification",
          runId: RUN_ID,
          taskId: "task_1",
          kind: "subagent",
          label: "explorer · 查依赖",
          status: "completed",
          summary: "找到 3 处引用",
          nextStep: "无",
          timestamp: T0,
        },
        {
          type: "task.notification",
          runId: RUN_ID,
          taskId: "task_2",
          kind: "command",
          label: "pnpm build",
          status: "failed",
          summary: "退出码 1",
          timestamp: at(1),
        },
      ),
      usage: null,
    });

    expect(timeline.entries[0]).toMatchObject({
      kind: "subagent",
      title: "explorer · 查依赖",
      status: "success",
      detail: "找到 3 处引用 · 下一步：无",
    });
    expect(timeline.entries[1]).toMatchObject({
      kind: "command",
      status: "error",
      detail: "退出码 1",
    });
  });

  it("消息增量与画布同步不进时间线", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "message.delta",
          runId: RUN_ID,
          messageId: "message-1",
          delta: "…",
          timestamp: T0,
        },
        { type: "canvas.sync", runId: RUN_ID, timestamp: at(1) },
        {
          type: "thinking.delta",
          runId: RUN_ID,
          messageId: "m",
          delta: "…",
          timestamp: at(2),
        },
      ),
      usage: null,
    });

    expect(timeline.entries).toEqual([]);
  });

  it("仓储用量优先于事件里的累计快照", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows({
        type: "run.usage",
        runId: RUN_ID,
        inputTokens: 10,
        outputTokens: 5,
        runInputTokens: 100,
        runOutputTokens: 50,
        timestamp: T0,
      }),
      usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.012 },
    });

    expect(timeline.run.usage).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      costUsd: 0.012,
    });
  });

  it("没有落账时回退到事件里的本轮累计值，成本留空", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        {
          type: "run.usage",
          runId: RUN_ID,
          inputTokens: 10,
          outputTokens: 5,
          runInputTokens: 90,
          runOutputTokens: 45,
          timestamp: T0,
        },
        {
          type: "run.usage",
          runId: RUN_ID,
          inputTokens: 20,
          outputTokens: 8,
          runInputTokens: 100,
          runOutputTokens: 50,
          timestamp: at(1),
        },
      ),
      usage: null,
    });

    expect(timeline.run.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: null,
    });
  });

  it("事件乱序时按 seq 重排后再配对", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: [
        { seq: 2, createdAt: at(2), event: completedTool() },
        { seq: 1, createdAt: T0, event: startedTool() },
      ],
      usage: null,
    });

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]?.durationMs).toBe(2_000);
  });

  it("没有事件时仍返回运行头部", () => {
    const timeline = buildRunTimeline({
      run: run({ errorCode: "x", errorMessage: "失败原因" }),
      events: [],
      usage: null,
    });

    expect(timeline.entries).toEqual([]);
    expect(timeline.run).toMatchObject({
      runId: RUN_ID,
      errorCode: "x",
      errorMessage: "失败原因",
      usage: null,
    });
  });

  it("时间戳不可解析时不编造耗时", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        { ...startedTool(), timestamp: "not-a-date" },
        completedTool({ timestamp: "also-not-a-date" }),
      ),
      usage: null,
    });

    expect(timeline.entries[0]?.durationMs).toBeUndefined();
  });

  it("工具输入的提示字段按优先级取第一个可用值", () => {
    const timeline = buildRunTimeline({
      run: run(),
      events: rows(
        startedTool({ patterns: ["a"], command: "  ls -la  " }),
        startedTool({ file_path: "src/b.ts" }),
        startedTool({ path: "/tmp/c" }),
        startedTool({ names: ["x", "y"] }),
      ),
      usage: null,
    });

    expect(timeline.entries.map((entry) => entry.detail)).toEqual([
      "ls -la",
      "src/b.ts",
      "/tmp/c",
      undefined,
    ]);
  });
});

describe("mergeChildEvents", () => {
  const DISPATCH = "call-task";

  function dispatchStarted(
    input?: Record<string, unknown>,
  ): RunTimelineEventRow {
    return {
      seq: 1,
      createdAt: T0,
      event: {
        type: "tool.started",
        runId: RUN_ID,
        toolCallId: DISPATCH,
        toolName: "Task",
        ...(input ? { input } : {}),
        timestamp: T0,
      },
    };
  }

  it("子代理工具事件并入父时间线，子 Run 起止与消息增量不重复出条目", () => {
    const merged = mergeChildEvents({
      runId: RUN_ID,
      parentEvents: [
        dispatchStarted({ subagent_type: "explore" }),
        {
          seq: 5,
          createdAt: at(5),
          event: {
            type: "tool.completed",
            runId: RUN_ID,
            toolCallId: DISPATCH,
            toolName: "Task",
            status: "success",
            timestamp: at(5),
          },
        },
      ],
      children: [
        {
          session: {
            childSessionId: "child-1",
            parentToolCallId: `${RUN_ID}/${DISPATCH}`,
          },
          events: [
            {
              seq: 2,
              createdAt: at(1),
              event: {
                type: "run.started",
                runId: "child-run",
                sessionId: "child-1",
                conversationId: "child-1",
                timestamp: at(1),
              },
            },
            {
              seq: 3,
              createdAt: at(2),
              event: {
                type: "tool.started",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                input: { file_path: "src/a.ts" },
                timestamp: at(2),
              },
            },
            {
              seq: 4,
              createdAt: at(3),
              event: {
                type: "tool.completed",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                status: "success",
                timestamp: at(3),
              },
            },
            {
              seq: 6,
              createdAt: at(4),
              event: {
                type: "message.delta",
                runId: "child-run",
                messageId: "m-1",
                delta: "…",
                timestamp: at(4),
              },
            },
          ],
        },
      ],
    });

    expect(merged.map((row) => row.seq)).toEqual([1, 5, 3, 4]);
    expect(merged[2]?.event).toMatchObject({
      agentName: "explore",
      agentCallId: "child-1",
    });
    expect(merged[3]?.event).toMatchObject({
      agentName: "explore",
      agentCallId: "child-1",
    });
  });

  it("并入后按 seq 穿插排序，父派发与子代理工具各自成条", () => {
    const parentEvents: RunTimelineEventRow[] = [
      dispatchStarted({ subagent_type: "explore" }),
      {
        seq: 6,
        createdAt: at(6),
        event: {
          type: "tool.started",
          runId: RUN_ID,
          toolCallId: "grep-1",
          toolName: "Grep",
          input: { pattern: "agent-runs" },
          timestamp: at(6),
        },
      },
    ];
    const merged = mergeChildEvents({
      runId: RUN_ID,
      parentEvents,
      children: [
        {
          session: {
            childSessionId: "child-1",
            parentToolCallId: `${RUN_ID}/${DISPATCH}`,
          },
          events: [
            {
              seq: 2,
              createdAt: at(2),
              event: {
                type: "tool.started",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                input: { file_path: "src/a.ts" },
                timestamp: at(2),
              },
            },
            {
              seq: 3,
              createdAt: at(3),
              event: {
                type: "tool.completed",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                status: "success",
                timestamp: at(3),
              },
            },
          ],
        },
      ],
    });

    const timeline = buildRunTimeline({
      run: run(),
      events: merged,
      usage: null,
    });

    expect(timeline.entries.map((entry) => entry.title)).toEqual([
      "Task",
      "Read",
      "Grep",
    ]);
    expect(timeline.entries[1]).toMatchObject({
      agentName: "explore",
      durationMs: 1_000,
      detail: "src/a.ts",
    });
  });

  it("派发关系缺失时不猜名称，事件自带的名称与分组键保持原值", () => {
    const merged = mergeChildEvents({
      runId: RUN_ID,
      parentEvents: [],
      children: [
        {
          session: {
            childSessionId: "child-2",
            parentToolCallId: `${RUN_ID}/unknown`,
          },
          events: [
            {
              seq: 1,
              createdAt: T0,
              event: {
                type: "tool.started",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                agentName: "review",
                agentCallId: "dispatch-9",
                timestamp: T0,
              },
            },
          ],
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({
      agentName: "review",
      agentCallId: "dispatch-9",
    });
  });

  it("派发关系缺失且事件无名称时只补分组键", () => {
    const merged = mergeChildEvents({
      runId: RUN_ID,
      parentEvents: [],
      children: [
        {
          session: {
            childSessionId: "child-3",
            parentToolCallId: `${RUN_ID}/unknown`,
          },
          events: [
            {
              seq: 1,
              createdAt: T0,
              event: {
                type: "tool.started",
                runId: "child-run",
                toolCallId: "read-1",
                toolName: "Read",
                timestamp: T0,
              },
            },
          ],
        },
      ],
    });

    expect(merged[0]?.event).toMatchObject({ agentCallId: "child-3" });
    const started = merged[0]?.event as
      | Extract<StreamEvent, { type: "tool.started" }>
      | undefined;
    expect(started?.agentName).toBeUndefined();
  });

  it("子代理治理事件保留，失败与用量事件不重复出条目", () => {
    const childEvent = (
      seq: number,
      event: StreamEvent,
    ): RunTimelineEventRow => ({ seq, createdAt: at(seq), event });
    const merged = mergeChildEvents({
      runId: RUN_ID,
      parentEvents: [dispatchStarted({ subagent_type: "worker" })],
      children: [
        {
          session: {
            childSessionId: "child-4",
            parentToolCallId: `${RUN_ID}/${DISPATCH}`,
          },
          events: [
            childEvent(2, {
              type: "run.retrying",
              runId: "child-run",
              attempt: 2,
              maxAttempts: 3,
              reason: "上游 429",
              timestamp: at(2),
            }),
            childEvent(3, {
              type: "run.compacted",
              runId: "child-run",
              origin: "auto",
              triggerTokens: 170_000,
              keepMessages: 20,
              timestamp: at(3),
            }),
            childEvent(4, {
              type: "run.hook",
              runId: "child-run",
              event: "turn-end",
              command: "echo done",
              exitCode: 0,
              timedOut: false,
              output: "",
              durationMs: 20,
              timestamp: at(4),
            }),
            childEvent(5, {
              type: "run.failed",
              runId: "child-run",
              error: { code: "run_failed", message: "子代理失败" },
              timestamp: at(5),
            }),
            childEvent(6, {
              type: "run.usage",
              runId: "child-run",
              inputTokens: 10,
              outputTokens: 5,
              timestamp: at(6),
            }),
          ],
        },
      ],
    });

    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });
});
