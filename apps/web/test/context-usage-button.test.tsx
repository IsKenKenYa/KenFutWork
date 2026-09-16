// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ContextUsageButton } from "../src/components/workbench/context-usage-button";

afterEach(() => {
  cleanup();
});

async function openPopover() {
  await userEvent.click(screen.getByRole("button", { name: "上下文容量" }));
  return screen.getByRole("dialog", { name: "上下文容量与缓存命中" });
}

describe("ContextUsageButton", () => {
  it("点开显示容量、百分比与缓存命中率", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 614_000, outputTokens: 1200, cachedInputTokens: 613_000 }}
        contextWindow={1_000_000}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("61.4万/100万（61.4%）");
    expect(dialog).toHaveTextContent("99.8%");
    expect(dialog).toHaveTextContent("61.4%");
  });

  it("上游没报缓存时显示「上游未上报」，不显示 0%", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 1000, outputTokens: 10 }}
        contextWindow={8192}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("上游未上报");
  });

  it("本轮没有用量（例如刚打开历史对话）时是空态而不是 0%", async () => {
    render(<ContextUsageButton usage={null} contextWindow={1_000_000} />);
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("本轮暂无用量");
    expect(dialog).not.toHaveTextContent("0%");
  });

  it("窗口已声明但本轮无用量：不写「没有声明上下文窗口」（回归）", async () => {
    render(<ContextUsageButton usage={null} contextWindow={1_000_000} />);
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("本轮暂无用量");
    expect(dialog).not.toHaveTextContent("没有声明上下文窗口");
  });

  it("模型没声明窗口时说明无法计算占比", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 1000, outputTokens: 10 }}
        contextWindow={null}
      />,
    );
    const dialog = await openPopover();
    // 窗口未知时不编百分比：读数里如实写「窗口未知」，也不写问号占位
    expect(dialog).toHaveTextContent("窗口未知");
    expect(dialog).not.toHaveTextContent("?");
  });
});
