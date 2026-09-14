import { describe, expect, it } from "vitest";

import {
  applyToolEvent,
  capTools,
  MAX_TASK_TOOLS,
  type TaskToolEntry,
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
