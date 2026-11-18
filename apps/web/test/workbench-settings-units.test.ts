import { describe, expect, it } from "vitest";
import {
  linesToRules,
  rulesToLines,
} from "../src/components/permission-section";
import {
  formatBuiltAt,
  formatBytes,
} from "../src/components/workbench/index-library-section";
import { buildOnboardingSteps } from "../src/components/workbench/onboarding-section";
import {
  getBrowserOpenTarget,
  setBrowserOpenTarget,
} from "../src/lib/browser-panel";

/**
 * R5-3 / R5-4 / R3-4 / R4-3 这几处的纯逻辑：
 * 权限规则文本 ↔ 数组、索引统计的可读化、默认打开位置偏好。
 */
describe("权限自定义规则文本转换", () => {
  it("一行一条：忽略空行与首尾空格，往返一致", () => {
    expect(linesToRules("write_file\n\n  mcp__*  \nexecute\n")).toEqual([
      "write_file",
      "mcp__*",
      "execute",
    ]);
    expect(rulesToLines(["a", "b"])).toBe("a\nb");
    expect(rulesToLines(linesToRules("x\n  y  \n\n"))).toBe("x\ny");
    expect(linesToRules("")).toEqual([]);
  });
});

describe("索引统计的可读化（R4-3）", () => {
  it("字节按量级缩写；构建时间无效时给占位", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBuiltAt("not-a-date")).toBe("—");
    expect(formatBuiltAt(new Date(2026, 8, 17, 10, 30).toISOString())).toMatch(
      /09\/17/,
    );
  });
});

describe("AI 任务默认浏览器偏好（R5-4）", () => {
  it("默认面板；设为系统浏览器后读回一致", () => {
    window.localStorage.clear();
    expect(getBrowserOpenTarget()).toBe("panel");
    setBrowserOpenTarget("system");
    expect(getBrowserOpenTarget()).toBe("system");
    window.localStorage.setItem("workbench:browser-open-target", "乱写的值");
    expect(getBrowserOpenTarget()).toBe("panel");
  });
});

describe("引导页的状态判定（R5-2）", () => {
  it("四步都按真实数据判定，不是写死的清单", () => {
    const empty = buildOnboardingSteps({
      providerCount: 0,
      hasWorkDir: false,
      permissionTier: "default",
      conversationCount: 0,
    });
    expect(empty.map((s) => s.done)).toEqual([false, false, false, false]);
    expect(empty.find((s) => s.id === "provider")?.tab).toBe("providers");

    const ready = buildOnboardingSteps({
      providerCount: 1,
      hasWorkDir: true,
      permissionTier: "auto-approve",
      conversationCount: 3,
    });
    expect(ready.every((s) => s.done)).toBe(true);
    // 默认档被视为「还没定过」（提示去想清楚），显式设过才算完成
    const defaultTier = buildOnboardingSteps({
      providerCount: 1,
      hasWorkDir: true,
      permissionTier: "default",
      conversationCount: 1,
    });
    expect(defaultTier.find((s) => s.id === "permission")?.done).toBe(false);
  });
});
