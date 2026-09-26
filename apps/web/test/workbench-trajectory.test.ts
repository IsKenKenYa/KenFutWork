import { describe, expect, it } from "vitest";
import type { TaskToolEntry } from "../src/lib/workbench-tools";
import {
  buildTimelineLayout,
  buildTimelineSpans,
  buildTrajectory,
  flattenTrajectory,
  rowsInSelection,
  type TrajectoryRow,
  turnRailItems,
} from "../src/lib/workbench-trajectory";

/** 轨迹账本（buildTrajectory）的纯逻辑测试：按轮分组、行序即时序、时间缺省如实为 null。 */

function tool(
  toolCallId: string,
  extra: Partial<TaskToolEntry> = {},
): TaskToolEntry {
  return { toolCallId, toolName: "read_file", status: "completed", ...extra };
}

function textRow(row: TrajectoryRow | undefined): string | null {
  return row?.kind === "text" ? row.text : null;
}

describe("buildTrajectory 按轮分组", () => {
  it("用户消息开一轮；其后助手文本段与工具调用按发生顺序归属该轮", () => {
    const model = buildTrajectory([
      { role: "user", text: "读一下", startedAt: 1000, blocks: [] },
      {
        role: "assistant",
        text: "先读",
        startedAt: 1100,
        blocks: [
          { type: "text", text: "先读", at: 1100 },
          {
            type: "tool",
            tool: tool("t1", { startedAt: 1200, endedAt: 1500 }),
          },
          { type: "text", text: "读完", at: 1600 },
        ],
      },
      { role: "user", text: "再读", startedAt: 2000, blocks: [] },
      {
        role: "assistant",
        text: "工具先到",
        startedAt: 2100,
        blocks: [{ type: "tool", tool: tool("t2", { startedAt: 2050 }) }],
      },
    ]);
    expect(model.turns).toHaveLength(2);
    expect(model.toolCount).toBe(2);
    expect(model.turns[0]?.index).toBe(1);
    expect(model.turns[0]?.toolCount).toBe(1);
    expect(model.turns[1]?.index).toBe(2);
    // 第二轮的工具归第二轮（不再全堆底/串轮）
    expect(model.turns[1]?.rows[0]?.kind).toBe("user");
    expect(model.turns[1]?.rows[1]?.kind).toBe("tool");
    // 第一轮内：文本与工具按发生顺序交错
    const rows = model.turns[0]?.rows ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["user", "text", "tool", "text"]);
    expect(textRow(rows[1])).toBe("先读");
    expect(textRow(rows[3])).toBe("读完");
  });

  it("工具行给出发生时间与耗时；缺端时不伪造", () => {
    const model = buildTrajectory([
      {
        role: "assistant",
        text: "",
        blocks: [
          { type: "tool", tool: tool("t1", { startedAt: 100, endedAt: 350 }) },
          { type: "tool", tool: tool("t2", { startedAt: 500 }) },
          { type: "tool", tool: tool("t3") },
        ],
      },
    ]);
    const rows = model.turns[0]?.rows ?? [];
    expect(rows[0]?.kind === "tool" && rows[0].durationMs).toBe(250);
    expect(rows[0]?.kind === "tool" && rows[0].atMs).toBe(100);
    expect(rows[1]?.kind === "tool" && rows[1].durationMs).toBeNull();
    expect(rows[2]?.kind === "tool" && rows[2].atMs).toBeNull();
  });

  it("空消息序列得到空模型", () => {
    expect(buildTrajectory([])).toEqual({ turns: [], toolCount: 0 });
  });

  it("连续工具调用保留为多行（不做聚合折叠）", () => {
    const model = buildTrajectory([
      {
        role: "assistant",
        text: "",
        blocks: [
          { type: "tool", tool: tool("a") },
          { type: "tool", tool: tool("b") },
          { type: "tool", tool: tool("c") },
        ],
      },
    ]);
    const kinds = (model.turns[0]?.rows ?? []).map((r) => r.kind);
    expect(kinds).toEqual(["tool", "tool", "tool"]);
  });
});

describe("思考行与 runId 归属", () => {
  it("reasoning 块成为「思考」行，位置即时序；runId 透传到行", () => {
    const model = buildTrajectory([
      {
        role: "assistant",
        text: "结论",
        runId: "run-1",
        startedAt: 1100,
        blocks: [
          { type: "reasoning", text: "想一想", at: 1100 },
          { type: "text", text: "结论", at: 1300 },
        ],
      },
    ]);
    const rows = model.turns[0]?.rows ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["reasoning", "text"]);
    expect(rows[0]).toMatchObject({
      kind: "reasoning",
      text: "想一想",
      runId: "run-1",
    });
    expect(rows[1]?.runId).toBe("run-1");
  });

  it("工具行的 runId 优先取工具条目自己的（旧消息级兜底）", () => {
    const model = buildTrajectory([
      {
        role: "assistant",
        text: "",
        runId: "run-old",
        blocks: [
          {
            type: "tool",
            tool: tool("t1", {
              runId: "run-new",
              startedAt: 100,
              endedAt: 200,
            }),
          },
        ],
      },
    ]);
    expect(model.turns[0]?.rows[0]).toMatchObject({
      kind: "tool",
      runId: "run-new",
    });
  });
});

describe("flattenTrajectory 全局行号", () => {
  it("跨轮连续编号，key 稳定可作 DOM 锚", () => {
    const model = buildTrajectory([
      { role: "user", text: "一", startedAt: 1000, blocks: [] },
      {
        role: "assistant",
        text: "答一",
        blocks: [{ type: "text", text: "答一" }],
      },
      { role: "user", text: "二", startedAt: 2000, blocks: [] },
      {
        role: "assistant",
        text: "答二",
        blocks: [{ type: "text", text: "答二" }],
      },
    ]);
    const flat = flattenTrajectory(model);
    expect(flat.map((e) => e.number)).toEqual([1, 2, 3, 4]);
    expect(flat[0]?.key).toBe("t1-r0");
    expect(flat[2]?.key).toBe("t2-r0");
    expect(flat[3]?.key).toBe("t2-r1");
  });
});

describe("buildTimelineSpans 时间轴几何", () => {
  const model = buildTrajectory([
    { role: "user", text: "问", startedAt: 1000, blocks: [] },
    {
      role: "assistant",
      text: "",
      startedAt: 1100,
      blocks: [
        { type: "tool", tool: tool("t1", { startedAt: 1100, endedAt: 2100 }) },
        { type: "tool", tool: tool("no-time") },
      ],
    },
  ]);

  it("时长模式：按真实时刻与耗时定位；缺时刻的行如实跳过", () => {
    const spans = buildTimelineSpans(model, "duration");
    // 起点 1000、终点 2100 → 跨度 1100；t1 从 0% 起、宽约 90.9%
    expect(spans).toHaveLength(2);
    // 用户行：时刻点（1.2% 细条）落在 0%
    expect(spans[0]).toMatchObject({ key: "t1-r0", xPercent: 0 });
    // 工具行 t1：从 9.09% 起、宽 90.9%（耗时占比，下限 1.2%）
    expect(spans[1]?.key).toBe("t1-r1");
    expect(spans[1]?.xPercent).toBeCloseTo(9.09, 1);
    expect(spans[1]?.widthPercent).toBeCloseTo(90.9, 1);
    // 无时刻的工具行（t1-r2）不出现在时长模式
    expect(spans.map((s) => s.key)).not.toContain("t1-r2");
  });

  it("时序模式：全部行（含缺时刻的）等距铺开", () => {
    const spans = buildTimelineSpans(model, "sequence");
    expect(spans).toHaveLength(3);
    expect(spans[0]?.xPercent).toBe(0);
    expect(spans[2]?.xPercent).toBe(96);
  });
});

describe("buildTimelineLayout 与拖选聚焦", () => {
  const model = buildTrajectory([
    { role: "user", text: "问", startedAt: 1000, blocks: [] },
    {
      role: "assistant",
      text: "",
      startedAt: 1100,
      blocks: [
        { type: "tool", tool: tool("t1", { startedAt: 1100, endedAt: 2100 }) },
        { type: "text", text: "答", at: 2200 },
      ],
    },
  ]);

  it("时长模式布局带时间基准；sequence 模式没有（不支持拖选）", () => {
    const duration = buildTimelineLayout(model, "duration");
    expect(duration.minStartMs).toBe(1000);
    expect(duration.spanMs).toBe(1200);
    expect(duration.spans).toHaveLength(3);
    const sequence = buildTimelineLayout(model, "sequence");
    expect(sequence.minStartMs).toBeNull();
    expect(sequence.spanMs).toBeNull();
  });

  it("rowsInSelection：可见条与选区相交即命中（WYSIWYG）；缺条的行不出现", () => {
    const flat = flattenTrajectory(model);
    const spans = buildTimelineLayout(model, "duration").spans;
    // 全宽选区：所有有条的行都命中
    expect(rowsInSelection(flat, spans, 0, 100)).toHaveLength(3);
    // 只框最后一段（正文条的 clamp 位置附近）
    const lastSpan = spans[spans.length - 1];
    expect(
      rowsInSelection(flat, spans, (lastSpan?.xPercent ?? 0) - 1, 100).map(
        (e) => e.row.kind,
      ),
    ).toEqual(["text"]);
    // 正文条被 clamp 到 98.8% 显示：框 99-100% 仍应命中它（WYSIWYG 的意义所在）
    expect(
      rowsInSelection(flat, spans, 99, 100).map((e) => e.row.kind),
    ).toEqual(["text"]);
  });

  it("空模型：布局为空且无时间基准", () => {
    const layout = buildTimelineLayout(buildTrajectory([]), "duration");
    expect(layout.spans).toEqual([]);
    expect(layout.minStartMs).toBeNull();
  });
});

describe("turnRailItems 时间线刻度项", () => {
  it("一轮一项：用户消息预览 + 助手首行预览，压缩换行", () => {
    const model = buildTrajectory([
      { role: "user", text: "第一问\n第二行", startedAt: 1000, blocks: [] },
      {
        role: "assistant",
        text: "答一",
        runId: "r1",
        blocks: [
          { type: "tool", tool: tool("t1") },
          { type: "text", text: "答一正文" },
        ],
      },
    ]);
    const items = turnRailItems(model);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      index: 1,
      userPreview: "第一问 第二行",
      assistantPreview: "答一正文",
      startedAtMs: 1000,
    });
  });

  it("长预览按上限截断；没有助手输出的轮给空串", () => {
    const model = buildTrajectory([
      { role: "user", text: "长".repeat(200), startedAt: 1000, blocks: [] },
      {
        role: "assistant",
        text: "",
        blocks: [{ type: "tool", tool: tool("t1") }],
      },
    ]);
    const items = turnRailItems(model);
    expect(items[0]?.userPreview.length).toBeLessThanOrEqual(120);
    expect(items[0]?.userPreview.endsWith("…")).toBe(true);
    expect(items[0]?.assistantPreview).toBe("");
  });
});

describe("轨迹账本的后台任务通知行（DEC-15）", () => {
  it("task_notification 块投影为 notification 行，按 at 排时间", () => {
    const messages = [
      { role: "user", text: "跑", startedAt: 1_000, blocks: [] },
      {
        role: "assistant",
        text: "",
        startedAt: 2_000,
        blocks: [
          {
            type: "task_notification",
            notification: {
              taskId: "t1",
              kind: "command",
              label: "pnpm build",
              status: "completed",
              summary: "ok",
            },
            at: 5_000,
          },
        ],
      },
    ] as never;
    const model = buildTrajectory(messages);
    expect(model.turns[0]?.rows[0]?.kind).toBe("user");
    expect(model.turns[0]?.rows[1]?.kind).toBe("notification");
    expect(model.turns[0]?.rows[1]).toMatchObject({ atMs: 5_000 });
  });
});
