import { describe, expect, it } from "vitest";

import {
  resolveWorkbenchSurface,
  type WorkbenchMode,
  type WorkbenchSurface,
} from "../src/lib/workbench-surface";

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

  /**
   * Flow 模式（《flow 集成方案》P1）：入口与画布随宿主适配层（P2）落地，但主区判定
   * 先按同一条不变量收口——flow 的主区是工作流画布，同样不许被对话框顶掉。
   */
  it("Flow + 已选项目 → 画布（工作流画布，同样不许对话框顶掉）", () => {
    expect(
      resolveWorkbenchSurface({
        mode: "flow",
        hasSelectedProject: true,
        hasActiveTask: true,
      }),
    ).toBe("canvas");

    expect(
      resolveWorkbenchSurface({
        mode: "flow",
        hasSelectedProject: true,
        hasActiveTask: false,
      }),
    ).toBe("canvas");
  });

  it("Flow + 尚无项目 → 编排器", () => {
    expect(
      resolveWorkbenchSurface({
        mode: "flow",
        hasSelectedProject: false,
        hasActiveTask: true,
      }),
    ).toBe("orchestrator");
  });

  it("穷举：Flow 模式在任何输入组合下都不会得到 conversation", () => {
    for (const hasSelectedProject of [true, false]) {
      for (const hasActiveTask of [true, false]) {
        expect(
          resolveWorkbenchSurface({
            mode: "flow",
            hasSelectedProject,
            hasActiveTask,
          }),
          `flow/${hasSelectedProject}/${hasActiveTask} 不应是对话框`,
        ).not.toBe("conversation");
      }
    }
  });

  /**
   * 全矩阵：三个模式 × 两个输入 = 12 种组合逐一点名。新加模式时这里与实现同改，
   * 任何一处顺序回归（例如把 activeTask 排在画布之前）都会立刻红灯。
   */
  it("穷举全矩阵：三模式 × 已选项目 × 有会话", () => {
    const cases: Array<[WorkbenchMode, boolean, boolean, WorkbenchSurface]> = [
      // Code：有会话看对话框，无会话看编排器（与是否选中项目无关）
      ["code", true, true, "conversation"],
      ["code", true, false, "orchestrator"],
      ["code", false, true, "conversation"],
      ["code", false, false, "orchestrator"],
      // Design / Flow：主区恒为画布，项目缺位时才回落编排器（有会话也不改判）
      ["design", true, true, "canvas"],
      ["design", true, false, "canvas"],
      ["design", false, true, "orchestrator"],
      ["design", false, false, "orchestrator"],
      ["flow", true, true, "canvas"],
      ["flow", true, false, "canvas"],
      ["flow", false, true, "orchestrator"],
      ["flow", false, false, "orchestrator"],
    ];

    for (const [mode, hasSelectedProject, hasActiveTask, surface] of cases) {
      const actual = resolveWorkbenchSurface({
        mode,
        hasSelectedProject,
        hasActiveTask,
      });
      expect(
        actual,
        `${mode}/${hasSelectedProject}/${hasActiveTask} 应为 ${surface}，实际 ${actual}`,
      ).toBe(surface);
    }
  });
});
