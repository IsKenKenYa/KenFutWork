import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

// 别名在 vitest.config 与 code-ui vite 构建同口径：@zui/chat-input-toolbar/contextUsage.js
// → host/contextUsageAdapter（G6 旧版 16px 圆环 + HoverCard）。
// dist-types 仍是 vendored 原签名（cache 只声明 hitRate、必填 intl/locale 等），
// 宿主件运行时签名更宽——测试按运行时传参，类型断言放宽。
const module = await import("@zui/chat-input-toolbar/contextUsage.js");
const ChatContextUsage =
  module.ChatContextUsage as unknown as React.ComponentType<{
    taskUsage: unknown;
  }>;
const getRenderableTaskUsage = module.getRenderableTaskUsage as <
  T extends { used: number; size: number },
>(
  taskUsage: T | null,
) => T | null;

afterEach(() => cleanup());

test("圆环随占用渲染，读数走旧口径（两位小数百分比）", () => {
  render(
    <ChatContextUsage
      taskUsage={{
        used: 45_000,
        size: 1_000_000,
        cache: {
          inputTokens: 45_000,
          cacheReadTokens: 30_000,
          cacheWriteTokens: 0,
          totalInputTokens: 80_000,
          totalCacheReadTokens: 60_000,
          totalCacheWriteTokens: 0,
          hitRate: 0.75,
        },
      }}
    />,
  );
  const ring = screen.getByTestId("context-usage-ring");
  expect(ring.getAttribute("title")).toContain("4.5万/100万");
  expect(ring.getAttribute("title")).toContain("4.5%");
});

test("窗口未知（size=0）不编分母，占位读数只给绝对量", () => {
  render(<ChatContextUsage taskUsage={{ used: 45_000, size: 0 }} />);
  expect(screen.getByTestId("context-usage-ring").getAttribute("title")).toBe(
    "4.5万（窗口未知）",
  );
});

test("无数据渲染空环（不画假弧），非法 taskUsage 判不可渲染", () => {
  render(<ChatContextUsage taskUsage={null} />);
  expect(screen.getByTestId("context-usage-ring").getAttribute("title")).toBe(
    "上下文容量",
  );
  expect(getRenderableTaskUsage(null)).toBeNull();
  expect(getRenderableTaskUsage({ used: 0, size: 100 })).toBeNull();
  expect(getRenderableTaskUsage({ used: 10, size: 100 })).toEqual({
    used: 10,
    size: 100,
  });
});
