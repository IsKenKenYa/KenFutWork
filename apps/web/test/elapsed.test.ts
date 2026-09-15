import { describe, expect, it } from "vitest";

import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";

describe("formatElapsedSeconds（R1-1 工作时间口径）", () => {
  it("不足一分钟只显示秒", () => {
    expect(formatElapsedSeconds(0)).toBe("0 秒");
    expect(formatElapsedSeconds(6)).toBe("6 秒");
    expect(formatElapsedSeconds(59)).toBe("59 秒");
  });

  it("一分钟以上显示分秒（对齐参考图「39 分 6 秒」）", () => {
    expect(formatElapsedSeconds(60)).toBe("1 分 0 秒");
    expect(formatElapsedSeconds(39 * 60 + 6)).toBe("39 分 6 秒");
    expect(formatElapsedSeconds(3599)).toBe("59 分 59 秒");
  });

  it("一小时以上显示时分秒", () => {
    expect(formatElapsedSeconds(3600)).toBe("1 时 0 分 0 秒");
    expect(formatElapsedSeconds(2 * 3600 + 5 * 60 + 7)).toBe("2 时 5 分 7 秒");
  });

  it("负数输入按 0 兜底（时钟回拨/乱序事件不产生负时长）", () => {
    expect(formatElapsedSeconds(-5)).toBe("0 秒");
  });
});

describe("elapsedSecondsBetween", () => {
  const start = Date.parse("2026-09-15T10:00:00Z");

  it("结束缺省时按 now 估算（运行中每秒走表）", () => {
    expect(elapsedSecondsBetween(start, undefined, start + 65_000)).toBe(65);
  });

  it("起止差值取整秒", () => {
    expect(elapsedSecondsBetween(start, start + 90_400, start + 91_000)).toBe(
      90,
    );
  });

  it("结束早于开始（乱序事件）不产生负数", () => {
    expect(elapsedSecondsBetween(start, start - 1000, start)).toBe(0);
  });
});

describe("parseTimestampMs", () => {
  it("解析 ISO（含时区偏移，与 WS 事件 timestampSchema 一致）", () => {
    expect(parseTimestampMs("2026-09-15T18:00:00+08:00")).toBe(
      Date.parse("2026-09-15T10:00:00Z"),
    );
  });

  it("无效输入返回 null（调用方隐藏条目而不是 NaN 显示）", () => {
    expect(parseTimestampMs("not-a-time")).toBeNull();
  });
});
