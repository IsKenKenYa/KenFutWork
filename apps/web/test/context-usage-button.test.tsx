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
        usage={{
          inputTokens: 614_000,
          outputTokens: 1200,
          cachedInputTokens: 613_000,
        }}
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

/**
 * 三段条与阈值刻度（上下文容量的可见形态）：已用 + 预留输出 + 剩余，
 * 越线时给琥珀色警示并写明「本产品不做自动压缩」——不摆「到时自动处理」的假承诺。
 */
describe("ContextUsageButton：预留输出与阈值", () => {
  it("模型声明了最大输出：显示三段读数与阈值刻度", async () => {
    const { container } = render(
      <ContextUsageButton
        usage={{ inputTokens: 500_000, outputTokens: 1200 }}
        contextWindow={1_000_000}
        maxOutputTokens={128_000}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("已用 50万");
    expect(dialog).toHaveTextContent("预留输出 12.8万");
    expect(dialog).toHaveTextContent("剩余 37.2万");
    // 阈值刻度（87.2% 处的细线）+ 预留段（琥珀）
    const threshold = container.querySelector('[style*="left: 87.2%"]');
    expect(threshold).not.toBeNull();
    // 未越线：没有警示文案
    expect(dialog).not.toHaveTextContent("已越过输出预留线");
  });

  it("越过预留线：琥珀警示 + 明确写「不做自动压缩」并给出行动", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 950_000, outputTokens: 1200 }}
        contextWindow={1_000_000}
        maxOutputTokens={128_000}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("已越过输出预留线");
    expect(dialog).toHaveTextContent("不做自动压缩");
    expect(dialog).toHaveTextContent("新建一个对话");
  });

  it("没声明最大输出：不显示预留段与阈值（少画而不是编一个数）", async () => {
    const { container } = render(
      <ContextUsageButton
        usage={{ inputTokens: 500_000, outputTokens: 1200 }}
        contextWindow={1_000_000}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).not.toHaveTextContent("预留输出");
    expect(dialog).not.toHaveTextContent("剩余");
    expect(container.querySelector('[style*="left: 87.2%"]')).toBeNull();
  });
});
