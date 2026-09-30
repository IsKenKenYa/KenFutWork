import { describe, expect, it } from "vitest";
import type { TaskToolEntry } from "../src/lib/workbench-tools";
import {
  toToolCallTreeNode,
  toToolCallTreeNodes,
} from "../src/lib/zcode-adapter";

/**
 * zcode-adapter 单测（手册 §4.3）：TaskToolEntry → TaskChatToolCallTreeNode 投影。
 * 覆盖全状态映射、失败摘要判定、字段透传、批量保序、树形恒主层。
 */

function entry(overrides: Partial<TaskToolEntry>): TaskToolEntry {
  return {
    toolCallId: "call_1",
    toolName: "read_file",
    status: "completed",
    ...overrides,
  };
}

describe("zcode-adapter：状态映射", () => {
  it("running → in_progress", () => {
    expect(
      toToolCallTreeNode(entry({ status: "running" })).toolCall.status,
    ).toBe("in_progress");
  });

  it("completed（正常结论）→ completed", () => {
    const node = toToolCallTreeNode(
      entry({ status: "completed", summary: "读取完成 63 行" }),
    );
    expect(node.toolCall.status).toBe("completed");
  });

  it("completed + 「失败」前缀 summary → failed（归约层口径）", () => {
    const node = toToolCallTreeNode(
      entry({ status: "completed", summary: "失败：文件不存在" }),
    );
    expect(node.toolCall.status).toBe("failed");
    expect(node.toolCall.error).toBe("失败：文件不存在");
  });

  it("denied → stopped（被拦未执行），错误文本透传", () => {
    const node = toToolCallTreeNode(
      entry({ status: "denied", summary: "被权限档拦下" }),
    );
    expect(node.toolCall.status).toBe("stopped");
    expect(node.toolCall.error).toBe("被权限档拦下");
  });

  it("正常完成不产 error 字段", () => {
    const node = toToolCallTreeNode(
      entry({ status: "completed", summary: "ok" }),
    );
    expect(
      "error" in node.toolCall ? node.toolCall.error : undefined,
    ).toBeUndefined();
  });
});

describe("zcode-adapter：字段投影", () => {
  it("toolId/toolName/kind/input/output 透传，title 取 summary 首行", () => {
    const node = toToolCallTreeNode(
      entry({
        toolCallId: "call_9",
        toolName: "execute",
        input: { command: "ls -la" },
        output: { output: "total 0" },
        summary: "第一行结论\n第二行补充",
        startedAt: 1727600000000,
      }),
    );
    const tc = node.toolCall;
    expect(tc.toolId).toBe("call_9");
    // 身份映射：execute → zcode 注册名 Bash（renderer 分流依据）
    expect(tc.toolName).toBe("Bash");
    expect(tc.kind).toBe("Bash");
    expect(tc.input).toEqual({ command: "ls -la" });
    expect(tc.output).toEqual({ output: "total 0" });
    expect(tc.title).toBe("第一行结论");
    expect(tc.startedAt).toBe(1727600000000);
    expect(tc.parentToolUseId).toBeNull();
  });

  it("无 summary 时无 title；超长 summary 首行截断到 120", () => {
    const noTitle = toToolCallTreeNode(entry({ status: "running" }));
    expect(
      "title" in noTitle.toolCall ? noTitle.toolCall.title : undefined,
    ).toBeUndefined();

    const long = toToolCallTreeNode(
      entry({ status: "completed", summary: `${"x".repeat(200)}\n尾行` }),
    );
    expect(long.toolCall.title?.length).toBe(120);
    expect(long.toolCall.title?.endsWith("…")).toBe(true);
  });

  it("入参缺失（running 首事件未带 input）投影为 undefined 不抛错", () => {
    // overrides 不带 input 键即「缺失」；显式 `input: undefined` 在 exactOptionalPropertyTypes
    // 下无法通过 Partial<TaskToolEntry>（行为与缺键完全等价）。
    const node = toToolCallTreeNode(entry({ status: "running" }));
    expect(node.toolCall.input).toBeUndefined();
    expect(node.childToolCalls).toEqual([]);
  });
});

describe("zcode-adapter：agent 家族映射（P3）", () => {
  it("subagent_task → Task（agent 家族），input.subagent_type 保留供名字读取", () => {
    const node = toToolCallTreeNode(
      entry({
        toolCallId: "call_ag",
        toolName: "subagent_task",
        input: { subagent_type: "planner", description: "调研" },
      }),
    );
    expect(node.toolCall.toolName).toBe("Task");
    expect(node.toolCall.kind).toBe("Task");
    expect(
      (node.toolCall.input as { subagent_type?: string }).subagent_type,
    ).toBe("planner");
  });
});

describe("zcode-adapter：批量", () => {
  it("toToolCallTreeNodes 保序且逐条投影", () => {
    const nodes = toToolCallTreeNodes([
      entry({ toolCallId: "a", toolName: "ls" }),
      entry({ toolCallId: "b", toolName: "read_file" }),
    ]);
    expect(nodes.map((n) => n.toolCall.toolId)).toEqual(["a", "b"]);
    // ls → Glob / read_file → Read（zcode 注册名）
    expect(nodes.map((n) => n.toolCall.toolName)).toEqual(["Glob", "Read"]);
    expect(nodes.every((n) => n.childToolCalls.length === 0)).toBe(true);
  });
});
