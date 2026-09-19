import type { CheckpointSummary } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  checkpointKindLabel,
  formatCheckpointOption,
  formatCheckpointStats,
  pickCheckpointForRun,
  toCheckpointOptions,
} from "../src/lib/checkpoint-select.js";

/** 造一行合法的检查点（shadowCommit 必须是 40 位十六进制，见契约 schema）。 */
function mkRow(overrides: Partial<CheckpointSummary> = {}): CheckpointSummary {
  return {
    id: "ckpt-1",
    runId: "run-1",
    kind: "turn",
    label: "轮次结束快照",
    shadowCommit: "a".repeat(40),
    filesChanged: 3,
    insertions: 12,
    deletions: 4,
    createdAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("pickCheckpointForRun", () => {
  it("空列表：返回 null", () => {
    expect(pickCheckpointForRun([], "run-1")).toBeNull();
  });

  it("runId 不匹配：全部过滤掉，返回 null", () => {
    const rows = [
      mkRow({ id: "ckpt-a", runId: "run-other" }),
      mkRow({ id: "ckpt-b", runId: null }),
    ];
    expect(pickCheckpointForRun(rows, "run-1")).toBeNull();
  });

  it("只有开始快照：返回这一行（失败/无改动收尾的轮也能回滚）", () => {
    const start = mkRow({
      id: "ckpt-start",
      label: "轮次开始快照",
      createdAt: "2026-09-20T10:00:00.000Z",
    });
    expect(pickCheckpointForRun([start], "run-1")).toEqual(start);
  });

  it("前后都有：取 createdAt 更晚的结束快照（输入乱序也挑对）", () => {
    const end = mkRow({
      id: "ckpt-end",
      label: "轮次结束快照",
      createdAt: "2026-09-20T10:05:00.000Z",
    });
    const start = mkRow({
      id: "ckpt-start",
      label: "轮次开始快照",
      createdAt: "2026-09-20T10:00:00.000Z",
    });
    expect(pickCheckpointForRun([end, start], "run-1")).toEqual(end);
  });

  it("多轮 run 混在一条时间线：只认本 run 的行", () => {
    const rows = [
      mkRow({
        id: "prev-run",
        runId: "run-0",
        createdAt: "2026-09-20T09:00:00.000Z",
      }),
      mkRow({ id: "mine-start", createdAt: "2026-09-20T10:00:00.000Z" }),
      mkRow({
        id: "mine-end",
        createdAt: "2026-09-20T10:05:00.000Z",
        filesChanged: 1,
      }),
      mkRow({
        id: "next-run",
        runId: "run-2",
        createdAt: "2026-09-20T11:00:00.000Z",
      }),
    ];
    expect(pickCheckpointForRun(rows, "run-1")?.id).toBe("mine-end");
  });

  it("createdAt 相同：取列表靠后的行（升序里靠后即更晚落行）", () => {
    const same = "2026-09-20T10:00:00.000Z";
    const rows = [
      mkRow({ id: "first", createdAt: same }),
      mkRow({ id: "second", createdAt: same, filesChanged: 9 }),
    ];
    expect(pickCheckpointForRun(rows, "run-1")?.id).toBe("second");
  });

  it("createdAt 畸形：不抛错，仍挑出该 run 的行", () => {
    const rows = [
      mkRow({ id: "bad-ts", createdAt: "not-a-timestamp" }),
      mkRow({ id: "good-ts", createdAt: "2026-09-20T10:05:00.000Z" }),
    ];
    expect(pickCheckpointForRun(rows, "run-1")?.id).toBe("good-ts");
  });
});

describe("formatCheckpointStats", () => {
  it("常规统计：N 个文件 +a −d", () => {
    expect(formatCheckpointStats(mkRow())).toBe("3 个文件 +12 −4");
  });

  it("零改动行：显示 +0 −0 而不是空串", () => {
    expect(
      formatCheckpointStats(
        mkRow({ filesChanged: 0, insertions: 0, deletions: 0 }),
      ),
    ).toBe("0 个文件 +0 −0");
  });

  it("纯二进制改动：汇总行数折成 0（不出现 null/NaN）", () => {
    // 服务端口径：二进制文件没有行数概念（numstat 为 null），summarizeEntries
    // 汇总时按 0 计——chip 文案里绝不能出现 null/NaN。
    expect(
      formatCheckpointStats(
        mkRow({ filesChanged: 2, insertions: 0, deletions: 0 }),
      ),
    ).toBe("2 个文件 +0 −0");
  });
});

describe("toCheckpointOptions（回滚目标的候选列表）", () => {
  it("空列表：返回空数组", () => {
    expect(toCheckpointOptions([])).toEqual([]);
  });

  it("最新在前：服务端升序输入反转成倒序（同刻行靠后者在前）", () => {
    const rows = [
      mkRow({ id: "old", createdAt: "2026-09-20T09:00:00.000Z" }),
      mkRow({ id: "mid", createdAt: "2026-09-20T10:00:00.000Z" }),
      mkRow({ id: "new", createdAt: "2026-09-20T11:00:00.000Z" }),
    ];
    expect(toCheckpointOptions(rows).map((o) => o.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("不改入参：返回新数组（调用方可能还要原序时间线）", () => {
    const rows = [mkRow({ id: "a" }), mkRow({ id: "b" })];
    toCheckpointOptions(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("formatCheckpointOption（回滚目标下拉的文案）", () => {
  it("含类型中文标、本地时间与统计", () => {
    const text = formatCheckpointOption(
      mkRow({ kind: "turn", createdAt: "2026-09-20T10:05:00.000Z" }),
    );
    // 时间按本地时区渲染（HH:mm 补零），期望值从同一时间戳推导，不钉死时区
    const at = new Date("2026-09-20T10:05:00.000Z");
    expect(text).toContain("轮次快照");
    expect(text).toContain(
      `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
    );
    expect(text).toContain("3 个文件 +12 −4");
  });

  it("三类 kind 各有中文标（基线/回滚恢复点不会落成「轮次快照」）", () => {
    expect(checkpointKindLabel("baseline")).toBe("基线快照");
    expect(checkpointKindLabel("restore")).toBe("回滚恢复点");
    expect(checkpointKindLabel("turn")).toBe("轮次快照");
    expect(
      formatCheckpointOption(mkRow({ kind: "baseline" })),
    ).toContain("基线快照");
    expect(
      formatCheckpointOption(mkRow({ kind: "restore" })),
    ).toContain("回滚恢复点");
  });

  it("createdAt 畸形：不抛错，文案退化成「类型 · 统计」", () => {
    const text = formatCheckpointOption(
      mkRow({ createdAt: "not-a-timestamp" }),
    );
    expect(text).toBe("轮次快照 · 3 个文件 +12 −4");
  });
});
