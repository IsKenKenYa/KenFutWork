import { describe, expect, it } from "vitest";

import {
  applyTaskToolEvent,
  applyToolEvent,
  capTools,
  MAX_TASK_TOOLS,
  type TaskToolEntry,
  type TaskToolState,
} from "../src/lib/workbench-tools";

/**
 * 回归：工作台此前**完全忽略** tool.* 事件——用户只看得到模型的话术，看不到工具跑了
 * 什么；联网搜索的来源列表（产品早写好的 ToolOutputRenderer）因此从未在 Code 模式里
 * 出现过。这组用例把「按 toolCallId 归并、正常/失败都收尾、事件乱序不造孤儿行」钉住。
 */
describe("工作台工具轨迹", () => {
  it("tool.started → 新增执行中行；tool.completed → 就地收尾并带上结论与输出", () => {
    let tools: TaskToolEntry[] = [];
    tools = applyToolEvent(tools, {
      type: "tool.started",
      toolCallId: "c1",
      toolName: "web_search",
    });
    expect(tools).toEqual([
      { toolCallId: "c1", toolName: "web_search", status: "running" },
    ]);

    tools = applyToolEvent(tools, {
      type: "tool.completed",
      toolCallId: "c1",
      toolName: "web_search",
      outputSummary: "搜索来源 · Python",
      output: { query: "Python", results: [{ title: "a", link: "https://a" }] },
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolCallId: "c1",
      status: "completed",
      summary: "搜索来源 · Python",
    });
    expect(tools[0]?.output?.query).toBe("Python");
  });

  it("工具失败也收尾（outputSummary 形如「失败：…」），不会永远停在执行中", () => {
    let tools = applyToolEvent([], {
      type: "tool.started",
      toolCallId: "c9",
      toolName: "web_search",
    });
    tools = applyToolEvent(tools, {
      type: "tool.completed",
      toolCallId: "c9",
      toolName: "web_search",
      outputSummary: "失败：web_search 请求失败（API密钥无效），请检查搜索供应商配置。",
      output: { error: "…" },
    });
    expect(tools[0]?.status).toBe("completed");
    expect(tools[0]?.summary).toContain("失败：");
  });

  it("缺 toolCallId 的事件被丢弃（归并键缺失只会造出无法配对的幽灵行）", () => {
    const tools = applyToolEvent([], {
      type: "tool.started",
      toolName: "web_search",
    });
    expect(tools).toEqual([]);
  });

  it("completed 找不到对应行时不新增（不出现无先导的孤儿「已完成」行）", () => {
    const tools = applyToolEvent([], {
      type: "tool.completed",
      toolCallId: "ghost",
      toolName: "web_search",
    });
    expect(tools).toEqual([]);
  });

  it("轨迹有条数上限（整条任务写 localStorage，无上限会撑爆配额）", () => {
    let tools: TaskToolEntry[] = [];
    for (let i = 0; i < MAX_TASK_TOOLS + 5; i += 1) {
      tools = applyToolEvent(tools, {
        type: "tool.started",
        toolCallId: `c${i}`,
        toolName: "read_file",
      });
    }
    expect(tools).toHaveLength(MAX_TASK_TOOLS);
    // 保留的是最近的一批
    expect(tools[tools.length - 1]?.toolCallId).toBe(
      `c${MAX_TASK_TOOLS + 4}`,
    );
    expect(capTools([])).toEqual([]);
  });

  it("多工具交错：各自按 id 归并，互不干扰", () => {
    let tools = applyToolEvent([], {
      type: "tool.started",
      toolCallId: "a",
      toolName: "web_search",
    });
    tools = applyToolEvent(tools, {
      type: "tool.started",
      toolCallId: "b",
      toolName: "mcp__py-helper__add",
    });
    tools = applyToolEvent(tools, {
      type: "tool.completed",
      toolCallId: "b",
      toolName: "mcp__py-helper__add",
      outputSummary: "6912.0",
    });
    expect(tools.map((t) => [t.toolCallId, t.status])).toEqual([
      ["a", "running"],
      ["b", "completed"],
    ]);
  });
});

/**
 * 回归：一条工具事件必须**同时**喂给工具轨迹与子代理目录。
 *
 * 线上曾写成「先处理子代理、非子代理直接 return」，把下面的通用分支变成死代码，
 * 于是界面上从来没有普通工具（含被工具门拒绝的合成事件）的记录。
 */
describe("applyTaskToolEvent（工具事件 → 任务状态）", () => {
  it("普通工具也要进轨迹（不是只有子代理工具）", () => {
    const next = applyTaskToolEvent(
      { tools: [] } as TaskToolState,
      { type: "tool.started", toolCallId: "c1", toolName: "web_search" },
    );
    expect(next.tools).toEqual([
      { toolCallId: "c1", toolName: "web_search", status: "running" },
    ]);
    expect(next.subagents).toBeUndefined();
  });

  it("被工具门拒绝的合成事件同样进轨迹，并带出拒绝原因", () => {
    let state: TaskToolState = { tools: [] };
    state = applyTaskToolEvent(state, {
      type: "tool.started",
      toolCallId: "d1",
      toolName: "write_file",
    });
    state = applyTaskToolEvent(state, {
      type: "tool.completed",
      toolCallId: "d1",
      toolName: "write_file",
      outputSummary: "工具被拒绝（第 1 次）：plan 计划模式：计划批准前仅允许只读工具",
      output: { denied: true, reason: "plan 计划模式：计划批准前仅允许只读工具" },
    });

    expect(state.tools?.[0]).toMatchObject({
      status: "completed",
      summary: expect.stringContaining("工具被拒绝"),
      output: { denied: true },
    });
  });

  it("子代理工具同时进目录（两块状态一起更新）", () => {
    const started = applyTaskToolEvent(
      { tools: [], subagents: [] } as TaskToolState,
      { type: "tool.started", toolCallId: "s1", toolName: "task" },
    );
    expect(started.tools).toHaveLength(1);
    expect(started.subagents).toHaveLength(1);

    const done = applyTaskToolEvent(started, {
      type: "tool.completed",
      toolCallId: "s1",
      toolName: "task",
      timestamp: "2026-09-15T00:00:00.000Z",
    });
    // 子代理条目以 endedAt 表达终态（不是 status）
    expect(done.subagents?.[0]?.endedAt).toBe("2026-09-15T00:00:00.000Z");
  });
});
