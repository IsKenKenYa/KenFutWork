import { describe, expect, it } from "vitest";
import { parseTodos } from "../src/lib/todo-progress";
import {
  appendAssistantDelta,
  appendThinkingDelta,
  applyTaskToolEvent,
  capToolBlocks,
  groupAssistantBlocks,
  MAX_TOOL_BLOCKS_PER_MESSAGE,
  messagesBaseForResume,
  migrateLegacyTools,
  nextAssistantStartMs,
  rebuildAssistantBlocks,
  settleAssistantElapsed,
  settlePreviousAssistant,
  type TaskMessage,
  type TaskMessageBlock,
  type TaskToolEntry,
  type TaskToolState,
  toolDisplayLabel,
  toolTargetHint,
  toolTargetParts,
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
      // runStart（500ms）早于上一轮结束（1000ms）：链式取上一轮结束
      runStartedAt: "1970-01-01T00:00:00.500Z",
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
    // 链式值（3000）晚于本轮起点（500）：取链式
    expect(nextAssistantStartMs(messages, "1970-01-01T00:00:00.500Z")).toBe(
      3000,
    );

    const legacy: TaskMessage[] = [
      { role: "assistant", text: "a", elapsedMs: 2000 },
    ];
    // 老数据只有耗时推不出链式：退到 run 起点
    const runStart = new Date("1970-01-01T00:00:00.500Z").getTime();
    expect(nextAssistantStartMs(legacy, "1970-01-01T00:00:00.500Z")).toBe(
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

describe("appendThinkingDelta 思考流", () => {
  it("思考先于正文到达：新建助手消息承载 reasoning 块，且不并入 text", () => {
    const message = appendThinkingDelta(
      { role: "assistant", text: "" },
      "先分析结构",
    );
    expect(message.text).toBe("");
    expect(message.blocks).toEqual([
      expect.objectContaining({ type: "reasoning", text: "先分析结构" }),
    ]);
  });

  it("连续思考增量续写同一块；正文到达后新起 text 段（顺序即时间线）", () => {
    let message = appendThinkingDelta(
      { role: "assistant", text: "" },
      "第一段思考",
    );
    message = appendThinkingDelta(message, "，接着想");
    // 续写合并进同一块，且保持首块的 at（这一段思考的开始时刻不变）
    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "reasoning",
        text: "第一段思考，接着想",
      }),
    ]);
    message = appendAssistantDelta(message, "正文开始");
    // 正文新起一段（新块带 at 时间戳）
    expect(message.blocks?.[0]).toMatchObject({
      type: "reasoning",
      text: "第一段思考，接着想",
    });
    expect(message.blocks?.[1]).toMatchObject({
      type: "text",
      text: "正文开始",
    });
    expect(message.blocks).toHaveLength(2);
    expect(message.text).toBe("正文开始");
  });

  it("正文之后再思考：新起 reasoning 段，不污染正文", () => {
    let message = appendAssistantDelta(
      { role: "assistant", text: "" },
      "先写一段",
    );
    message = appendThinkingDelta(message, "想想接下来");
    expect(message.blocks?.[0]).toMatchObject({
      type: "text",
      text: "先写一段",
    });
    expect(message.blocks?.[1]).toMatchObject({
      type: "reasoning",
      text: "想想接下来",
    });
    expect(message.blocks).toHaveLength(2);
  });
});

describe("runId 归属（工具条目与新建助手消息）", () => {
  it("tool.started 的 runId 进条目；工具先于正文时新建的助手消息也带上", () => {
    const task = applyTaskToolEvent(baseTask, {
      type: "tool.started",
      toolCallId: "tc_run",
      toolName: "read_file",
      runId: "run-1",
    });
    const entry = toolBlocks(task.messages[0])[0];
    expect(entry?.runId).toBe("run-1");
    expect(task.messages[0]?.runId).toBe("run-1");
  });

  it("started 没带 runId 时，completed 补上归属", () => {
    let task = applyTaskToolEvent(baseTask, {
      type: "tool.started",
      toolCallId: "tc_late",
      toolName: "read_file",
    });
    task = applyTaskToolEvent(
      { ...task, messages: task.messages },
      {
        type: "tool.completed",
        toolCallId: "tc_late",
        toolName: "read_file",
        runId: "run-9",
      },
    );
    expect(toolBlocks(task.messages[0])[0]?.runId).toBe("run-9");
  });
});

describe("tool.completed 的产物（artifacts）", () => {
  it("产物写入工具条目（此前该字段被静默丢弃）", () => {
    const artifacts = [
      {
        type: "image" as const,
        url: "https://example.com/a.png",
        mimeType: "image/png",
        width: 512,
        height: 512,
      },
    ];
    let task = applyTaskToolEvent(baseTask, {
      type: "tool.started",
      toolCallId: "tc_art",
      toolName: "generate_image",
    });
    task = applyTaskToolEvent(task, {
      type: "tool.completed",
      toolCallId: "tc_art",
      toolName: "generate_image",
      artifacts,
    });
    expect(toolBlocks(task.messages[0])[0]?.artifacts).toEqual(artifacts);
  });
});

describe("tool.started 入参归一化", () => {
  it('服务端包装层（{input:"<json>"}）入库前剥掉——行内提示与详情才取得到值', () => {
    const task = applyTaskToolEvent(baseTask, {
      type: "tool.started",
      toolCallId: "tc_wrap",
      toolName: "write_file",
      input: { input: '{"path":"src/a.ts","content":"x"}' },
    });
    const entry = toolBlocks(task.messages[0])[0];
    expect(entry?.input).toEqual({ path: "src/a.ts", content: "x" });
    expect(entry ? toolTargetHint(entry) : null).toBe("src/a.ts");
  });

  it("归一化失败（不是 JSON 对象）保留原样，不丢字段", () => {
    const raw = { input: "not-json" };
    const task = applyTaskToolEvent(baseTask, {
      type: "tool.started",
      toolCallId: "tc_raw",
      toolName: "execute",
      input: raw,
    });
    expect(toolBlocks(task.messages[0])[0]?.input).toEqual(raw);
  });
});

describe("rebuildAssistantBlocks 服务端真序重建（含思考）", () => {
  it("thinking 块映射为 reasoning，且与正文/工具的位置关系保持真序", () => {
    const blocks = rebuildAssistantBlocks([
      { type: "thinking", thinking: "想一想" },
      { type: "text", text: "先说" },
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "read_file",
        input: { path: "a.ts" },
      },
      { type: "text", text: "再说" },
    ] as Parameters<typeof rebuildAssistantBlocks>[0]);
    expect(blocks.map((b) => b.type)).toEqual([
      "reasoning",
      "text",
      "tool",
      "text",
    ]);
    expect(blocks[0]).toMatchObject({ text: "想一想" });
  });
});

describe("rebuildAssistantBlocks 恢复 runId 与时间戳（PG 历史回灌）", () => {
  it("工具块上的 runId/startedAt/endedAt（ISO）换算进本地条目；旧数据缺省不伪造", () => {
    const blocks = rebuildAssistantBlocks([
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "execute",
        status: "completed",
        runId: "run-7",
        startedAt: "2026-09-21T00:00:01.000Z",
        endedAt: "2026-09-21T00:00:03.500Z",
        input: { command: "ls" },
      },
      {
        type: "tool",
        toolCallId: "t2",
        toolName: "read_file",
        status: "completed",
      },
    ] as Parameters<typeof rebuildAssistantBlocks>[0]);
    const [withTime, withoutTime] = blocks.map((b) =>
      b.type === "tool" ? b.tool : null,
    );
    expect(withTime?.runId).toBe("run-7");
    expect(withTime?.startedAt).toBe(Date.parse("2026-09-21T00:00:01.000Z"));
    expect(withTime?.endedAt).toBe(Date.parse("2026-09-21T00:00:03.500Z"));
    // 旧数据没有时间戳/归属：字段缺省，不伪造 0 或 NaN
    expect(withoutTime?.runId).toBeUndefined();
    expect(withoutTime?.startedAt).toBeUndefined();
    expect(withoutTime?.endedAt).toBeUndefined();
  });

  it("text 块的 at 恢复为毫秒；思考块的 at 同理", () => {
    const blocks = rebuildAssistantBlocks([
      { type: "thinking", thinking: "想一想", at: "2026-09-21T00:00:00.000Z" },
      { type: "text", text: "正文", at: "2026-09-21T00:00:02.000Z" },
    ] as Parameters<typeof rebuildAssistantBlocks>[0]);
    expect(blocks[0]).toMatchObject({
      type: "reasoning",
      at: Date.parse("2026-09-21T00:00:00.000Z"),
    });
    expect(blocks[1]).toMatchObject({
      type: "text",
      at: Date.parse("2026-09-21T00:00:02.000Z"),
    });
  });
});

describe("settleAssistantElapsed 终态结算（回归：不得抹掉 blocks/runId）", () => {
  it("保留 blocks 与 runId，只追加 elapsedMs", () => {
    const startedAt = Date.now() - 5_000;
    const task: { status: string; messages: TaskMessage[] } = {
      status: "completed",
      messages: [
        { role: "user", text: "问" },
        {
          role: "assistant",
          text: "答",
          startedAt,
          runId: "run-1",
          blocks: [
            { type: "text", text: "答" },
            {
              type: "tool",
              tool: {
                toolCallId: "t1",
                toolName: "execute",
                status: "completed",
                runId: "run-1",
              },
            },
          ],
        },
      ],
    };
    const settled = settleAssistantElapsed(task);
    const last = settled.messages[settled.messages.length - 1];
    expect(last?.blocks).toHaveLength(2);
    expect(last?.runId).toBe("run-1");
    expect(last?.elapsedMs).toBeGreaterThanOrEqual(5_000);
  });

  it("末条不是 assistant 或没有起点时原样返回", () => {
    const task = { messages: [{ role: "user" as const, text: "问" }] };
    expect(settleAssistantElapsed(task)).toBe(task);
  });
});

describe("nextAssistantStartMs 跨轮防陈旧", () => {
  it("追问隔了很久：本轮第一条消息的起点不早于本轮 run 起点（「已工作」不再被撑到几分钟）", () => {
    const messages: TaskMessage[] = [
      { role: "user", text: "一", startedAt: 1_000 },
      { role: "assistant", text: "答一", startedAt: 1_100, elapsedMs: 7_000 },
    ];
    // 上一轮结束 = 8_100；本轮 60 秒后才开始 → 起点应取本轮起点 68_100
    expect(nextAssistantStartMs(messages, "1970-01-01T00:01:08.100Z")).toBe(
      68_100,
    );
  });

  it("同轮内多段消息：仍链式取上一段结束（行为不变）", () => {
    const messages: TaskMessage[] = [
      { role: "assistant", text: "a", startedAt: 1_000, elapsedMs: 500 },
    ];
    expect(nextAssistantStartMs(messages, "1970-01-01T00:00:00.500Z")).toBe(
      1_500,
    );
  });
});

describe("messagesBaseForResume 断线重连基底", () => {
  it("丢掉最后一条用户消息之后的半截 assistant 内容，用户消息本身保留", () => {
    const messages: TaskMessage[] = [
      { role: "user", text: "一" },
      { role: "assistant", text: "答一" },
      { role: "user", text: "二" },
      {
        role: "assistant",
        text: "半截",
        blocks: [
          {
            type: "tool",
            tool: { toolCallId: "t1", toolName: "execute", status: "running" },
          },
        ],
      },
    ];
    const base = messagesBaseForResume(messages);
    expect(base).toHaveLength(3);
    expect(base[2]?.role).toBe("user");
  });

  it("没有用户消息（防御）返回空数组；空数组原样", () => {
    expect(messagesBaseForResume([{ role: "assistant", text: "a" }])).toEqual(
      [],
    );
    expect(messagesBaseForResume([])).toEqual([]);
  });
});

describe("toolTargetParts 目标三段拆分（ZCode 同款）", () => {
  it("路径：文件名为主、目录为次；Windows 分隔符归一", () => {
    expect(
      toolTargetParts({
        toolCallId: "t",
        toolName: "read_file",
        status: "completed",
        input: { path: "src/lib/workbench-tools.ts" },
      }),
    ).toEqual({
      primary: "workbench-tools.ts",
      rest: "src/lib",
      isCommand: false,
    });
    expect(
      toolTargetParts({
        toolCallId: "t",
        toolName: "edit_file",
        status: "completed",
        input: { file_path: "apps\\web\\src\\a.tsx" },
      }),
    ).toEqual({ primary: "a.tsx", rest: "apps/web/src", isCommand: false });
  });

  it("根相对文件名：无目录次文案", () => {
    expect(
      toolTargetParts({
        toolCallId: "t",
        toolName: "read_file",
        status: "completed",
        input: { path: "README.md" },
      }),
    ).toEqual({ primary: "README.md", rest: null, isCommand: false });
  });

  it("终端命令：isCommand 档，原样不截断（截断交给渲染层）", () => {
    const long = `python3 - <<'EOF' ${"x".repeat(200)}`;
    const parts = toolTargetParts({
      toolCallId: "t",
      toolName: "execute",
      status: "completed",
      input: { command: long },
    });
    expect(parts).toEqual({ primary: long, rest: null, isCommand: true });
  });

  it("查询/URL/模式：文本档", () => {
    expect(
      toolTargetParts({
        toolCallId: "t",
        toolName: "web_search",
        status: "completed",
        input: { query: "zcode ui" },
      }),
    ).toEqual({ primary: "zcode ui", rest: null, isCommand: false });
  });

  it("无入参或无目标键：null", () => {
    expect(
      toolTargetParts({
        toolCallId: "t",
        toolName: "execute",
        status: "completed",
      }),
    ).toBeNull();
  });
});
