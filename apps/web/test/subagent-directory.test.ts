import { describe, expect, it } from "vitest";
import {
  appendSubagentDelta,
  appendSubagentTool,
  closeAllSubagents,
  completeSubagent,
  completeSubagentByCallId,
  isSubagentTool,
  type SubagentEntry,
  summarizeSubagents,
  upsertSubagentStarted,
} from "@/lib/subagent-directory";
import { applyTaskToolEvent } from "../src/lib/workbench-tools";

const STARTED = "2026-09-15T10:00:00Z";
const ENDED = "2026-09-15T10:01:30Z";

describe("子代理目录（R1-3 子代理目录推导）", () => {
  it("识别子代理父工具（task 与 video_generate），普通工具不识别", () => {
    expect(isSubagentTool("task")).toBe(true);
    expect(isSubagentTool("video_generate")).toBe(true);
    expect(isSubagentTool("inspect_canvas")).toBe(false);
  });

  it("started 生成新条目：取输入显式名，缺省回落工具名", () => {
    const explicit = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      input: { name: "Explore", description: "审查仓库结构" },
      timestamp: STARTED,
    });
    expect(explicit[0]).toMatchObject({
      toolCallId: "t1",
      name: "Explore",
      description: "审查仓库结构",
      startedAt: STARTED,
    });

    const fallback = upsertSubagentStarted([], {
      toolCallId: "t2",
      toolName: "video_generate",
      timestamp: STARTED,
    });
    expect(fallback[0]?.name).toBe("video_generate");
  });

  it("completed 落终态；重复 completed 不覆盖既有终态", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = completeSubagent(list, "t1", ENDED);
    expect(list[0]?.endedAt).toBe(ENDED);
    list = completeSubagent(list, "t1", "2026-09-15T11:00:00Z");
    expect(list[0]?.endedAt).toBe(ENDED);
  });

  it("run 结束兜底关掉未完成的条目；已结束的保持原终态", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = upsertSubagentStarted(list, {
      toolCallId: "t2",
      toolName: "video_generate",
      timestamp: STARTED,
    });
    list = completeSubagent(list, "t2", ENDED);
    list = closeAllSubagents(list, "2026-09-15T10:05:00Z");
    expect(list.find((entry) => entry.toolCallId === "t1")?.endedAt).toBe(
      "2026-09-15T10:05:00Z",
    );
    expect(list.find((entry) => entry.toolCallId === "t2")?.endedAt).toBe(
      ENDED,
    );
  });

  it("汇总：运行中与已结束计数；重复 started 更新起始时刻而不是新增条目", () => {
    let list: SubagentEntry[] = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      timestamp: STARTED,
    });
    list = upsertSubagentStarted(list, {
      toolCallId: "t1",
      toolName: "task",
      timestamp: "2026-09-15T10:02:00Z",
    });
    expect(list).toHaveLength(1);
    expect(summarizeSubagents(list)).toEqual({ running: 1, finished: 0 });
  });
});

describe("子代理入参归一化（真实载荷是 {input: '<json>'} 包装）", () => {
  it("从包装后的入参里取到 name 与 description", () => {
    const wrapped = {
      input:
        '{"description":"审查 server 其余模块","name":"Explore","subagent_type":"Explore"}',
    };
    const list = upsertSubagentStarted([], {
      toolCallId: "t1",
      toolName: "task",
      input: wrapped,
      timestamp: STARTED,
    });
    expect(list[0]).toMatchObject({
      name: "Explore",
      description: "审查 server 其余模块",
    });
  });

  it("取不到名字时回落成工具名（行为不变）", () => {
    const list = upsertSubagentStarted([], {
      toolCallId: "t2",
      toolName: "task",
      input: { input: "not-json" },
      timestamp: STARTED,
    });
    expect(list[0]?.name).toBe("task");
    expect(list[0]?.description).toBeUndefined();
  });
});

describe("task_background 派发条目（DEC-15，经 applyTaskToolEvent 全链）", () => {
  const baseTask = () =>
    ({
      messages: [
        { role: "user", text: "开始", blocks: [] },
        { role: "assistant", text: "", startedAt: 1_000, blocks: [] },
      ],
    }) as unknown as Parameters<typeof applyTaskToolEvent>[0];

  it("task_background 派发成功不收尾条目（真终态走通知/兜底）", () => {
    let task = baseTask();
    task = applyTaskToolEvent(task, {
      type: "tool.started",
      toolCallId: "call-1",
      toolName: "task_background",
      input: { subagent_type: "explore", description: "调研" },
      timestamp: "2026-09-27T12:00:00.000Z",
    });
    expect(task.subagents?.[0]?.name).toBe("explore");

    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "call-1",
      toolName: "task_background",
      outputSummary: "已转为后台任务",
      timestamp: "2026-09-27T12:00:05.000Z",
    });
    expect(task.subagents?.[0]?.endedAt).toBeUndefined();
  });

  it("task 派发用 subagent_type 命名；task 自身完成照常收尾", () => {
    let task = baseTask();
    task = applyTaskToolEvent(task, {
      type: "tool.started",
      toolCallId: "call-2",
      toolName: "task",
      input: { subagent_type: "review", description: "审查" },
      timestamp: "2026-09-27T12:01:00.000Z",
    });
    expect(task.subagents?.[0]?.name).toBe("review");
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "call-2",
      toolName: "task",
      timestamp: "2026-09-27T12:02:00.000Z",
    });
    expect(task.subagents?.[0]?.endedAt).toBe("2026-09-27T12:02:00.000Z");
  });
});

describe("子代理视图路由（zcode 右栏模型：agentCallId）", () => {
  const entry = (): SubagentEntry[] => [
    {
      toolCallId: "parent-call-1",
      name: "explore",
      description: "调研",
      startedAt: "2026-09-27T12:00:00.000Z",
      blocks: [],
    },
  ];

  it("子代理内部工具按 agentCallId 进对应条目转录，started/completed 配对", () => {
    let list = entry();
    list = appendSubagentTool(list, {
      agentCallId: "parent-call-1",
      toolCallId: "child-tool-1",
      toolName: "ls",
      type: "tool.started",
      input: { path: "/" },
      timestamp: "2026-09-27T12:00:10.000Z",
    });
    list = appendSubagentTool(list, {
      agentCallId: "parent-call-1",
      toolCallId: "child-tool-1",
      toolName: "ls",
      type: "tool.completed",
      outputSummary: "12 项",
      timestamp: "2026-09-27T12:00:12.000Z",
    });
    expect(list[0]?.blocks).toHaveLength(1);
    const block = list[0]?.blocks[0];
    expect(block?.type).toBe("tool");
    if (block?.type === "tool") {
      expect(block.tool).toMatchObject({
        toolCallId: "child-tool-1",
        status: "completed",
        outputSummary: "12 项",
      });
    }
    // 别的条目不受影响
    const other = appendSubagentTool(entry(), {
      agentCallId: "parent-call-2",
      toolCallId: "child-tool-2",
      toolName: "ls",
      type: "tool.started",
    });
    expect(other[0]?.blocks).toHaveLength(0);
  });

  it("子代理正文/思考增量：末块同类续写，text 与 thinking 互不打断顺序", () => {
    let list = entry();
    list = appendSubagentDelta(list, "parent-call-1", "thinking", "先看结构");
    list = appendSubagentDelta(list, "parent-call-1", "text", "分析如下：");
    list = appendSubagentDelta(list, "parent-call-1", "text", "3 个模块");
    list = appendSubagentDelta(list, "parent-call-1", "thinking", "再深入");
    expect(list[0]?.blocks.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "thinking",
    ]);
    const text = list[0]?.blocks[1];
    if (text?.type === "text") expect(text.text).toBe("分析如下：3 个模块");
  });

  it("后台结算通知按 agentCallId 关条目；主对话不入这些块（类型层面隔离）", () => {
    const list = completeSubagentByCallId(
      entry(),
      "parent-call-1",
      "2026-09-27T12:05:00.000Z",
    );
    expect(list[0]?.endedAt).toBe("2026-09-27T12:05:00.000Z");
  });
});
