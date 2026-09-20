import { describe, expect, it } from "vitest";
import type { TaskToolEntry } from "../src/lib/workbench-tools";
import {
  buildTrajectory,
  type TrajectoryRow,
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
      { role: "user", text: "读一下", startedAt: 1000 },
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
      { role: "user", text: "再读", startedAt: 2000 },
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

  it("无 blocks 的旧数据整条落成一行正文；轮次收尾取下一轮起点", () => {
    const model = buildTrajectory([
      { role: "assistant", text: "开场白", startedAt: 100 },
      { role: "user", text: "问", startedAt: 900 },
    ]);
    expect(model.turns).toHaveLength(2);
    expect(textRow(model.turns[0]?.rows[0])).toBe("开场白");
    // 第 1 轮的结束 = 第 2 轮的开始（时长条据此画）
    expect(model.turns[0]?.endedAtMs).toBe(900);
    expect(model.turns[1]?.endedAtMs).toBeNull();
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
