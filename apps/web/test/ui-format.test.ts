import { describe, expect, it } from "vitest";
import { formatTaskRelativeTime, getPathLeaf } from "../src/lib/ui-format";

describe("getPathLeaf 路径叶子", () => {
  it("POSIX 路径取文件名", () => {
    expect(getPathLeaf("src/lib/a.ts")).toBe("a.ts");
    expect(getPathLeaf("/abs/path/b.json")).toBe("b.json");
  });

  it("Windows 路径也切", () => {
    expect(getPathLeaf("apps\\web\\src\\c.tsx")).toBe("c.tsx");
  });

  it("无分隔符原样返回", () => {
    expect(getPathLeaf("README.md")).toBe("README.md");
  });

  it("空串与结尾分隔符不崩溃", () => {
    expect(getPathLeaf("")).toBe("");
    // 结尾分隔符：叶子为空，防御性回退原值
    expect(getPathLeaf("src/lib/")).toBe("src/lib/");
  });
});

describe("formatTaskRelativeTime 相对时间（ZCode 同款口径）", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");

  it("<1 分钟：刚刚", () => {
    expect(formatTaskRelativeTime("2026-09-21T11:59:20.000Z", now)).toBe(
      "刚刚",
    );
  });

  it("未来时间戳（时钟偏差）按刚刚", () => {
    expect(formatTaskRelativeTime("2026-09-21T12:00:30.000Z", now)).toBe(
      "刚刚",
    );
  });

  it("<60 分钟：N 分", () => {
    expect(formatTaskRelativeTime("2026-09-21T11:01:00.000Z", now)).toBe(
      "59 分",
    );
    expect(formatTaskRelativeTime("2026-09-21T11:30:00.000Z", now)).toBe(
      "30 分",
    );
    expect(formatTaskRelativeTime(now - 5 * 60_000, now)).toBe("5 分");
  });

  it("<24 小时：N 小时", () => {
    expect(formatTaskRelativeTime("2026-09-21T00:00:00.000Z", now)).toBe(
      "12 小时",
    );
    expect(formatTaskRelativeTime("2026-09-20T13:00:00.000Z", now)).toBe(
      "23 小时",
    );
  });

  it("≥24 小时：N 天", () => {
    expect(formatTaskRelativeTime("2026-09-19T12:00:00.000Z", now)).toBe(
      "2 天",
    );
    expect(formatTaskRelativeTime("2026-09-20T12:00:00.000Z", now)).toBe(
      "1 天",
    );
  });

  it("畸形时间戳返回空串（不渲染 NaN）", () => {
    expect(formatTaskRelativeTime("not-a-date", now)).toBe("");
  });
});
