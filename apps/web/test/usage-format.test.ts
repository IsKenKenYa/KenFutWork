import { describe, expect, it } from "vitest";

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
