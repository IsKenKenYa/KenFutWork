import { describe, expect, it } from "vitest";

import { resolveWorkbenchSurface } from "../src/lib/workbench-surface";

/**
 * Design 模式「主区恒为画布」的回归锁。
 * 起因：主区判定曾内联在 JSX 里且把 `activeTask` 放在画布之前，导致设计模式
 * 一发消息就退化成对话框（用户多次反馈）。这组用例把顺序钉死。
 */
describe("工作台主区判定（Design 模式不变量）", () => {
  it("Design + 已选项目 → 画布（即便同时有激活的会话，也不许对话框顶掉画布）", () => {
    expect(
      resolveWorkbenchSurface({
        mode: "design",
        hasSelectedProject: true,
        hasActiveTask: true,
      }),
    ).toBe("canvas");

    expect(
      resolveWorkbenchSurface({
        mode: "design",
        hasSelectedProject: true,
        hasActiveTask: false,
      }),
    ).toBe("canvas");
  });

  it("Design + 尚无项目 → 编排器（占位，自动建项目后即进画布）", () => {
    expect(
      resolveWorkbenchSurface({
        mode: "design",
        hasSelectedProject: false,
        hasActiveTask: true,
      }),
    ).toBe("orchestrator");
  });

  it("Code 模式沿用原顺序：有会话看对话框，无会话看编排器", () => {
    expect(
      resolveWorkbenchSurface({
        mode: "code",
        hasSelectedProject: false,
        hasActiveTask: true,
      }),
    ).toBe("conversation");

    expect(
      resolveWorkbenchSurface({
        mode: "code",
        hasSelectedProject: false,
        hasActiveTask: false,
      }),
    ).toBe("orchestrator");
  });

  it("穷举：Design 模式在任何输入组合下都不会得到 conversation", () => {
    for (const hasSelectedProject of [true, false]) {
      for (const hasActiveTask of [true, false]) {
        expect(
          resolveWorkbenchSurface({
            mode: "design",
            hasSelectedProject,
            hasActiveTask,
          }),
          `design/${hasSelectedProject}/${hasActiveTask} 不应是对话框`,
        ).not.toBe("conversation");
      }
    }
  });
});
