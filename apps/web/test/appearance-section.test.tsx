// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceSection } from "../src/components/workbench/appearance-section";

/**
 * 设置 → 外观（R5-2 的「外观」条目）。
 *
 * 机制本来就在（next-themes 的 class 策略 + `.dark` 令牌 + 画布按 resolvedTheme 切主题），
 * 这一页锁的是：三选一真的写 `theme`、当前生效值如实显示、以及**偏好存本机**这件事
 * 在界面上说清楚了（外观是设备级的，不跟工作区设置绑）。
 */
const setTheme = vi.fn();
let themeValue = "system";
let resolved = "light";

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: themeValue,
    resolvedTheme: resolved,
    setTheme: (next: string) => {
      setTheme(next);
      themeValue = next;
      resolved = next === "dark" ? "dark" : "light";
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  themeValue = "system";
  resolved = "light";
});

describe("设置 → 外观", () => {
  it("三选一：浅色 / 深色 / 跟随系统，点了就写 theme", async () => {
    render(<AppearanceSection />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await userEvent.click(screen.getByRole("radio", { name: /深色/ }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("如实显示当前生效值（含「跟随系统」标注）", async () => {
    render(<AppearanceSection />);
    expect(await screen.findByText(/当前生效：浅色（跟随系统）/)).toBeVisible();
  });

  /**
   * 曾经这里断言「说明里点明本机存储与画布跟随」。2026-09-27 用户口径把界面文案收成
   * 「只写标签」（见 AGENTS.md「界面文案（硬约束）」），那句说明已删；这条改为**反过来**
   * 锁住它不再回来（设置区文案守卫 settings-copy-guard.test.ts 是同一口径的机械门禁）。
   */
  it("不再复述说明句（只留主题选项）", () => {
    render(<AppearanceSection />);
    // 三个选项标签都还在
    expect(screen.getByText("浅色")).toBeVisible();
    expect(screen.getByText("深色")).toBeVisible();
    expect(screen.getByText("跟随系统")).toBeVisible();
    expect(screen.queryByText(/主题保存在本机|画布与代码预览/)).toBeNull();
  });
});
