import { describe, expect, it } from "vitest";
import { monotonePath } from "../src/components/workbench/usage-stats-section";
import { formatDuration } from "../src/lib/usage-format";

describe("使用统计的时长格式化（R4-2「最长聊天时长」卡）", () => {
  it("按天/小时/分钟组合，零值段不出现", () => {
    expect(formatDuration(60)).toBe("1 分钟");
    expect(formatDuration(45 * 60)).toBe("45 分钟");
    expect(formatDuration(60 * 60)).toBe("1 小时");
    expect(formatDuration(11 * 3600 + 45 * 60)).toBe("11 小时 45 分钟");
    expect(formatDuration(24 * 3600)).toBe("1 天");
    expect(formatDuration(2 * 24 * 3600 + 3 * 3600)).toBe("2 天 3 小时");
  });

  it("不足一分钟说「不到 1 分钟」，无数据说「—」（不显示 0 分钟）", () => {
    expect(formatDuration(59)).toBe("不到 1 分钟");
    // 0 / 负数 / NaN 都是「没有可展示的时长」：0 分钟会被读成「测出来是 0」
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

/**
 * 折线平滑（用户反馈「曲线要光滑，不要那么尖」）。
 *
 * 用**单调三次插值**：普通样条会在峰值处过冲（把「一天暴涨」画成虚高的尖角甚至负值），
 * 限幅后曲线不会超出相邻数据点的范围。这里锁「路径形状」与「不过冲」两个关键性质。
 */
describe("单调三次平滑路径（每日 Token 趋势）", () => {
  const line = [
    { x: 0, y: 100 },
    { x: 10, y: 200 },
    { x: 20, y: 150 },
  ];

  it("生成三次贝塞尔路径（C 段数与点数一致），不再是折线段", () => {
    const d = monotonePath(line);
    expect(d.startsWith("M 0 100")).toBe(true);
    expect(d.match(/C /g)?.length).toBe(2);
    expect(d).not.toContain("L ");
  });

  it("平坦段（相邻 y 相同）切线为 0：不会在平线上鼓包", () => {
    const d = monotonePath([
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 50 },
    ]);
    // 控制点的 y 必须都等于 50，否则平线会被画成波浪
    const ys = [...d.matchAll(/[-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys)).toEqual(new Set([50]));
  });

  it("单点与空数组不炸（返回可渲染的最小路径）", () => {
    expect(monotonePath([])).toBe("");
    expect(monotonePath([{ x: 3, y: 4 }])).toBe("M 3 4");
  });
});
