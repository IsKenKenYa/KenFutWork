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

/**
 * 容量圆环按参考图 1:1 复刻（用户口径）：**环里不写数字**，读法靠弧长——
 * 弧画的是「还剩多少」，缺口是已用掉的那一小段（还给一个最小缺口，免得看着像个实心点）。
 *
 * 锁四件事：没有数字文本、缺口随用量变化、0% 也留一个最小缺口、没有数据时画闭合环。
 */
describe("ContextUsageButton：圆环形态（1:1 复刻）", () => {
  const dashOf = (container: HTMLElement): [number, number] => {
    const circles = Array.from(
      container.querySelectorAll("button[aria-label='上下文容量'] circle"),
    );
    const arc = circles.at(-1);
    const dash = (arc?.getAttribute("stroke-dasharray") ?? "0 0").split(" ");
    return [Number(dash[0]), Number(dash[1])];
  };

  it("环里不写百分比（用户口径：算了，不显示在环上了）", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const button = screen.getByRole("button", { name: "上下文容量" });
    expect(button.textContent?.trim()).toBe("");
    // 精确读数仍在 title 里（环不带数字，但信息不能丢）
    expect(button.getAttribute("title")).toContain("4.5万/100万（4.5%）");
  });

  it("弧长 = 剩余空间：4.5% 用量几乎满环（缺口取最小值），61.4% 用量缺口明显", () => {
    const low = render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const [lowArc, lowTotal] = dashOf(low.container);
    // 环周长 C = 2πr，r = (22-2.5)/2 = 9.75 → C ≈ 61.3（细环：描边 2.5，参考图口径）
    expect(lowTotal).toBeCloseTo(61.3, 0);
    // 用途极小 → 缺口被夹到 6%（至少看得出是个「C」）
    expect(lowArc / lowTotal).toBeCloseTo(0.94, 2);
    cleanup();

    const high = render(
      <ContextUsageButton
        usage={{ inputTokens: 614_000, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const [highArc, highTotal] = dashOf(high.container);
    expect(highArc / highTotal).toBeCloseTo(0.386, 2);
  });

  it("没有用量数据：画一圈闭合的灰环（不编缺口）", () => {
    const { container } = render(
      <ContextUsageButton usage={null} contextWindow={1_000_000} />,
    );
    const [arc, total] = dashOf(container);
    expect(arc).toBeCloseTo(total, 1);
  });
});
