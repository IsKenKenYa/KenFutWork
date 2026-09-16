import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  measureMessages,
  measureTools,
  mergeComposition,
} from "./prompt-composition.js";

/**
 * 上下文容量的分类占比（R4-1 那一栏）。
 *
 * 口径是**字符数**（上游不提供分类 token）——这里锁三件事：分类正确、技能工具结果
 * 单独归「技能」、工具 schema 按 `mcp__` 前缀分 MCP / 系统。
 */
describe("提示词分段（分类占比的采集口径）", () => {
  it("SystemMessage → 系统提示词；Human/AI/Tool → 消息", () => {
    const parts = measureMessages([
      new SystemMessage("system-prompt"),
      new HumanMessage("hello"),
      new AIMessage("hi there"),
      new ToolMessage({
        content: "tool result",
        tool_call_id: "c1",
        name: "read_file",
      }),
    ]);

    const byLabel = Object.fromEntries(parts.map((p) => [p.label, p.chars]));
    expect(byLabel["系统提示词"]).toBe("system-prompt".length);
    expect(byLabel["消息"]).toBe(
      "hello".length + "hi there".length + "tool result".length,
    );
    expect(byLabel["技能"]).toBeUndefined();
  });

  it("技能工具的**结果**归「技能」（技能文档就是这么进上下文的）", () => {
    const parts = measureMessages([
      new ToolMessage({
        content: "技能正文",
        tool_call_id: "c1",
        name: "use_skill",
      }),
      new ToolMessage({
        content: "技能清单",
        tool_call_id: "c2",
        name: "list_skills",
      }),
    ]);
    expect(parts).toEqual([
      { label: "技能", chars: "技能正文".length + "技能清单".length },
    ]);
  });

  it("认不出的消息形态归「其他」（例如非文本块）", () => {
    const parts = measureMessages([
      {
        content: [{ type: "image", data: "xxx" }],
        constructor: { name: "WeirdMessage" },
      },
    ]);
    expect(parts[0]?.label).toBe("其他");
    expect(parts[0]?.chars).toBeGreaterThan(0);
  });

  it("工具 schema：mcp__ 前缀归 MCP 工具，其余归系统工具", () => {
    const parts = measureTools([
      { name: "read_file", description: "读文件", schema: {} },
      { name: "mcp__py_helper__add", description: "加法", schema: {} },
    ]);
    const labels = parts.map((p) => p.label);
    expect(labels).toContain("系统工具");
    expect(labels).toContain("MCP 工具");
    // 系统工具只算内置那份、MCP 只算 mcp__ 那份（不互相吞）
    const system = parts.find((p) => p.label === "系统工具");
    const mcp = parts.find((p) => p.label === "MCP 工具");
    expect(system?.chars).toBe(
      JSON.stringify({ name: "read_file", description: "读文件", schema: {} })
        .length,
    );
    expect(mcp?.chars).toBe(
      JSON.stringify({
        name: "mcp__py_helper__add",
        description: "加法",
        schema: {},
      }).length,
    );
  });

  it("合并：同类相加、丢 0、降序（浮层按这个顺序列）", () => {
    const merged = mergeComposition([
      { label: "消息", chars: 100 },
      { label: "系统提示词", chars: 10 },
      { label: "消息", chars: 50 },
      { label: "技能", chars: 0 },
    ]);
    expect(merged).toEqual([
      { label: "消息", chars: 150 },
      { label: "系统提示词", chars: 10 },
    ]);
  });
});
