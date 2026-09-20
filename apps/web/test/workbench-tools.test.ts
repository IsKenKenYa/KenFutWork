import { describe, expect, it } from "vitest";
import { parseTodos } from "../src/lib/todo-progress";
import {
  appendAssistantDelta,
  applyTaskToolEvent,
  capToolBlocks,
  groupAssistantBlocks,
  MAX_TOOL_BLOCKS_PER_MESSAGE,
  migrateLegacyTools,
  nextAssistantStartMs,
  settlePreviousAssistant,
  type TaskMessage,
  type TaskMessageBlock,
  type TaskToolEntry,
  type TaskToolState,
  toolDisplayLabel,
  toolTargetHint,
} from "../src/lib/workbench-tools";

/**
 * 工具轨迹的纯逻辑测试（workbench Code 模式）。
 *
 * 锁住两条用户口径：
 * 1. 工具调用**跟着所属的那轮助手消息**渲染、按发生顺序与正文交错——
 *    不再全堆在对话最底部（看不出属于谁/哪一轮），也不再被整条任务 10 条的
 *    上限截断（2026-09-20 反馈；参考 deepseek-harness turn-process /
 *    Cherry Studio ToolBlockGroup）。
 * 2. 普通工具也要进轨迹（2026-09-15 回归：非子代理工具曾被 early return 吃掉，
 *    界面上从来没有任何工具调用记录）。
 */

const baseTask: TaskToolState = {
  messages: [],
  subagents: [],
};

function toolBlocks(message: TaskMessage | undefined): TaskToolEntry[] {
  if (!message) return [];
  return (message.blocks ?? [])
    .filter(
      (b): b is { type: "tool"; tool: TaskToolEntry } => b.type === "tool",
    )
    .map((b) => b.tool);
}

describe("applyTaskToolEvent 工具轨迹", () => {
  it("普通工具也进轨迹（不要求是子代理工具）", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "正在读文件" }] },
      {
        type: "tool.started",
        toolCallId: "tc_1",
        toolName: "read_file",
      },
    );
    expect(toolBlocks(task.messages[0])).toHaveLength(1);
    expect(toolBlocks(task.messages[0])[0]).toMatchObject({
      toolCallId: "tc_1",
      toolName: "read_file",
      status: "running",
    });
  });

  it("同一 toolCallId 的重复 started 不重复入块", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      { type: "tool.started", toolCallId: "tc_1", toolName: "read_file" },
    );
    const task2 = applyTaskToolEvent(task, {
      type: "tool.started",
      toolCallId: "tc_1",
      toolName: "read_file",
    });
    expect(toolBlocks(task2.messages[0])).toHaveLength(1);
  });

  it("completed 就地收尾对应块（状态/结论/输出）", () => {
    let task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      { type: "tool.started", toolCallId: "tc_1", toolName: "read_file" },
    );
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "tc_1",
      outputSummary: "读到了 12 行",
      output: { ok: true },
      timestamp: "2026-09-20T02:10:30.000Z",
    });
    expect(toolBlocks(task.messages[0])[0]).toMatchObject({
      status: "completed",
      summary: "读到了 12 行",
      output: { ok: true },
    });
  });

  it("找不到块的 completed 不造孤儿行", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "正文" }] },
      {
        type: "tool.completed",
        toolCallId: "tc_missing",
        toolName: "read_file",
      },
    );
    expect(task.messages).toHaveLength(1);
    expect(toolBlocks(task.messages[0])).toHaveLength(0);
  });

  it("被拒（output.denied）记为 denied，不伪装成已完成", () => {
    let task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      { type: "tool.started", toolCallId: "tc_1", toolName: "write_file" },
    );
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "tc_1",
      output: {
        denied: true,
        reason: "工具 write_file 属危险操作，等待用户审批",
      },
    });
    expect(toolBlocks(task.messages[0])[0]?.status).toBe("denied");
  });

  it("tool.started 带上入参快照（行内显示动了什么）", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      {
        type: "tool.started",
        toolCallId: "tc_1",
        toolName: "read_file",
        input: { path: "/tmp/a.ts" },
      },
    );
    expect(toolBlocks(task.messages[0])[0]?.input).toEqual({
      path: "/tmp/a.ts",
    });
  });

  it("工具先于正文到达：先建一条空文本助手消息，工具块在最前", () => {
    const task = applyTaskToolEvent(
      { ...baseTask },
      { type: "tool.started", toolCallId: "tc_1", toolName: "read_file" },
    );
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0]?.role).toBe("assistant");
    expect(task.messages[0]?.blocks).toEqual([
      { type: "tool", tool: expect.objectContaining({ toolCallId: "tc_1" }) },
    ]);
    // 新助手消息必须起表，否则这条消息永远没有「已工作」时长
    expect(task.messages[0]?.startedAt).toBeTypeOf("number");
  });

  it("跨轮归属：第二轮的工具进第二条助手消息，第一条不受影响（不再全堆底/被截断）", () => {
    let task = {
      ...baseTask,
      messages: [
        { role: "user" as const, text: "读一下" },
        {
          role: "assistant" as const,
          text: "第一轮回",
          elapsedMs: 1000,
          startedAt: 0,
        },
      ],
      runStartedAt: "2026-09-20T02:10:00.000Z",
    };
    // 第二轮：用户追问 → 工具先到 → 正文再到
    task = {
      ...task,
      messages: [...task.messages, { role: "user" as const, text: "再读" }],
    };
    task = applyTaskToolEvent(task, {
      type: "tool.started",
      toolCallId: "tc_b",
      toolName: "read_file",
    });
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "tc_b",
      output: { ok: true },
    });
    // 第二条助手消息（索引 3）：只有工具块
    expect(toolBlocks(task.messages[3])).toHaveLength(1);
    // 第一轮的助手消息（索引 1）没有被塞进任何工具
    expect(toolBlocks(task.messages[1])).toHaveLength(0);
    // 新消息起点链式推：上一条（起点 0 + 1000ms）
    expect(task.messages[3]?.startedAt).toBe(1000);
  });

  it("单条消息的工具块超上限时丢最旧", () => {
    const blocks: TaskMessageBlock[] = Array.from(
      { length: MAX_TOOL_BLOCKS_PER_MESSAGE + 5 },
      (_, i) => ({
        type: "tool" as const,
        tool: {
          toolCallId: `tc_${i}`,
          toolName: "read_file",
          status: "completed" as const,
        },
      }),
    );
    const capped = capToolBlocks(blocks);
    expect(capped).toHaveLength(MAX_TOOL_BLOCKS_PER_MESSAGE);
    const kept = capped.filter(
      (b): b is { type: "tool"; tool: TaskToolEntry } => b.type === "tool",
    );
    expect(kept[0]?.tool.toolCallId).toBe("tc_5");
  });

  it("write_todos 覆盖式更新目标进度", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      {
        type: "tool.started",
        toolCallId: "tc_1",
        toolName: "write_todos",
        input: {
          todos: [
            { content: "第一件事", status: "completed" },
            { content: "第二件事", status: "in_progress" },
          ],
        },
      },
    );
    expect(task.todos).toEqual(
      parseTodos({
        todos: [
          { content: "第一件事", status: "completed" },
          { content: "第二件事", status: "in_progress" },
        ],
      }),
    );
  });

  it("write_todos 入参不可解析时保持原进度", () => {
    const task = applyTaskToolEvent(
      {
        ...baseTask,
        messages: [{ role: "assistant", text: "" }],
        todos:
          parseTodos({
            todos: [{ content: "旧目标", status: "in_progress" }],
          }) ?? [],
      },
      { type: "tool.started", toolCallId: "tc_1", toolName: "write_todos" },
    );
    expect(task.todos).toHaveLength(1);
    expect(task.todos?.[0]?.content).toBe("旧目标");
  });
});

describe("appendAssistantDelta 文本增量并入有序块", () => {
  it("追加到最后一段文本", () => {
    const msg = appendAssistantDelta(
      {
        role: "assistant",
        text: "你好",
        blocks: [{ type: "text", text: "你好" }],
      },
      "世界",
    );
    expect(msg.text).toBe("你好世界");
    expect(msg.blocks).toEqual([{ type: "text", text: "你好世界" }]);
  });

  it("末尾是工具调用时新起一段（工具之后的正文不糊成一段），新段带到达时刻", () => {
    const msg = appendAssistantDelta(
      {
        role: "assistant",
        text: "读完",
        blocks: [
          { type: "text", text: "读完" },
          {
            type: "tool",
            tool: {
              toolCallId: "t",
              toolName: "read_file",
              status: "completed",
            },
          },
        ],
      },
      "了文件",
    );
    expect(msg.text).toBe("读完了文件");
    expect(msg.blocks).toHaveLength(3);
    // 旧段不动；新段（工具之后的正文）第一个字到达的时刻要记下（轨迹视图用）
    expect(msg.blocks?.[0]).toEqual({ type: "text", text: "读完" });
    expect(msg.blocks?.[2]).toMatchObject({ type: "text", text: "了文件" });
    const newSegment = msg.blocks?.[2];
    expect(newSegment?.type === "text" && typeof newSegment.at).toBe("number");
  });

  it("空 delta 原样返回", () => {
    const msg: TaskMessage = { role: "assistant", text: "x" };
    expect(appendAssistantDelta(msg, "")).toBe(msg);
  });
});

describe("groupAssistantBlocks 连续工具块并组", () => {
  it("相邻 tool 块并成一组，text 打断连续性", () => {
    const groups = groupAssistantBlocks([
      { type: "text", text: "先读" },
      {
        type: "tool",
        tool: { toolCallId: "a", toolName: "read_file", status: "completed" },
      },
      {
        type: "tool",
        tool: { toolCallId: "b", toolName: "read_file", status: "completed" },
      },
      { type: "text", text: "再写" },
      {
        type: "tool",
        tool: { toolCallId: "c", toolName: "edit_file", status: "denied" },
      },
    ]);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toEqual({ kind: "text", text: "先读" });
    expect(groups[1]).toMatchObject({
      kind: "tools",
      tools: [
        expect.objectContaining({ toolCallId: "a" }),
        expect.objectContaining({ toolCallId: "b" }),
      ],
    });
    expect(groups[2]).toEqual({ kind: "text", text: "再写" });
    expect(groups[3]).toMatchObject({
      kind: "tools",
      tools: [expect.objectContaining({ toolCallId: "c" })],
    });
  });
});

describe("toolDisplayLabel / toolTargetHint", () => {
  it("常见工具映射中文标签，未知工具原样返回", () => {
    expect(toolDisplayLabel("edit_file")).toBe("编辑文件");
    expect(toolDisplayLabel("execute")).toBe("终端");
    expect(toolDisplayLabel("web_search")).toBe("联网搜索");
    expect(toolDisplayLabel("some_new_tool")).toBe("some_new_tool");
  });

  it("行内提示优先取路径/命令/查询，超长截断", () => {
    expect(
      toolTargetHint({
        toolCallId: "t",
        toolName: "read_file",
        status: "completed",
        input: { path: "/tmp/a.ts" },
      }),
    ).toBe("/tmp/a.ts");
    expect(
      toolTargetHint({
        toolCallId: "t",
        toolName: "execute",
        status: "completed",
        input: { command: "x".repeat(80) },
      }),
    ).toHaveLength(48);
    expect(
      toolTargetHint({
        toolCallId: "t",
        toolName: "read_file",
        status: "completed",
      }),
    ).toBeNull();
  });
});

describe("耗时起表", () => {
  it("起点链式推：上一条 起点+耗时；老数据（只有耗时）退到 run 起点", () => {
    const messages: TaskMessage[] = [
      { role: "assistant", text: "a", elapsedMs: 2000, startedAt: 1000 },
    ];
    expect(nextAssistantStartMs(messages, "2026-09-20T02:10:00.000Z")).toBe(
      3000,
    );

    const legacy: TaskMessage[] = [
      { role: "assistant", text: "a", elapsedMs: 2000 },
    ];
    const runStart = new Date("2026-09-20T02:10:00.000Z").getTime();
    expect(nextAssistantStartMs(legacy, "2026-09-20T02:10:00.000Z")).toBe(
      runStart,
    );
  });

  it("只结算第一条未结算的助手消息", () => {
    const messages: TaskMessage[] = [
      { role: "user", text: "问" },
      { role: "assistant", text: "a", elapsedMs: 1000, startedAt: 0 },
      { role: "assistant", text: "b", startedAt: 1000 },
    ];
    const settled = settlePreviousAssistant(messages, 4500);
    expect(settled[1]?.elapsedMs).toBe(1000);
    expect(settled[2]?.elapsedMs).toBe(3500);
  });
});

describe("工具事件的起止时刻（轨迹视图数据源）", () => {
  it("tool.started/tool.completed 的事件 timestamp 落成 startedAt/endedAt", () => {
    let task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      {
        type: "tool.started",
        toolCallId: "tc_t",
        toolName: "read_file",
        timestamp: "2026-09-20T02:10:01.000Z",
      },
    );
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "tc_t",
      toolName: "read_file",
      timestamp: "2026-09-20T02:10:03.500Z",
    });
    const tool = toolBlocks(task.messages[0])[0];
    expect(tool?.startedAt).toBe(Date.parse("2026-09-20T02:10:01.000Z"));
    expect(tool?.endedAt).toBe(Date.parse("2026-09-20T02:10:03.500Z"));
  });

  it("事件缺 timestamp 时不伪造时刻", () => {
    const task = applyTaskToolEvent(
      { ...baseTask, messages: [{ role: "assistant", text: "" }] },
      { type: "tool.started", toolCallId: "tc_t", toolName: "read_file" },
    );
    const tool = toolBlocks(task.messages[0])[0];
    expect(tool?.startedAt).toBeUndefined();
  });
});

describe("migrateLegacyTools 旧数据迁移", () => {
  it("任务级 tools 挂进最后一条助手消息", () => {
    const migrated = migrateLegacyTools<{
      messages: TaskMessage[];
      tools: TaskToolEntry[];
    }>({
      messages: [
        { role: "user", text: "问" },
        { role: "assistant", text: "答" },
      ],
      tools: [{ toolCallId: "t1", toolName: "read_file", status: "completed" }],
    });
    const blocks = migrated.messages[1]?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "答" });
    expect(blocks[1]).toMatchObject({ type: "tool" });
    expect(migrated.messages[0]?.blocks).toBeUndefined();
  });

  it("没有 legacy tools 时原样返回", () => {
    const messages: TaskMessage[] = [{ role: "assistant", text: "答" }];
    expect(migrateLegacyTools({ messages })).toEqual({ messages });
  });
});
