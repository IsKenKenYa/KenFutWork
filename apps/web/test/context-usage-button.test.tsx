// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ContextUsageButton } from "../src/components/workbench/context-usage-button";

afterEach(() => {
  cleanup();
});

/** 面板是**悬停**展开的（用户口径：「鼠标放上去悬浮显示，而不是点击才出来」）。 */
async function openPopover() {
  await userEvent.hover(screen.getByRole("button", { name: "上下文容量" }));
  return screen.getByRole("dialog", { name: "上下文容量与缓存命中" });
}

describe("ContextUsageButton", () => {
  it("悬停即展开，移开才收起（不是点击才出来）", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const trigger = screen.getByRole("button", { name: "上下文容量" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.hover(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 点击不该把它关掉（悬停时面板本来就开着，toggle 会立刻关＝用户点不到）
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("从环挪进面板时不收起（环与面板之间那 8px 空隙有防抖）", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const trigger = screen.getByRole("button", { name: "上下文容量" });
    await userEvent.hover(trigger);
    const dialog = screen.getByRole("dialog");
    // 指针移到面板上（面板是容器的子节点，不算「离开」）
    await userEvent.hover(dialog);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("展开后显示容量、百分比与缓存命中率", async () => {
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
    // 不补零：61.4% 不写成 61.40%（两位小数是精度，不是噪声）
    expect(dialog).not.toHaveTextContent("61.40%");
    expect(dialog).toHaveTextContent("99.8%");
    expect(dialog).toHaveTextContent("61.4%");
  });

  it("缓存命中率的条与上下文「已用」同色（用户口径：也要一样的蓝）", async () => {
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
    const cacheBar = dialog.querySelector('[style*="width: 99.8"]');
    expect(cacheBar?.className).toContain("bg-info");
    expect(cacheBar?.className).not.toContain("emerald");
  });

  it("模型没报缓存时显示「模型未提供」，不显示 0%", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 1000, outputTokens: 10 }}
        contextWindow={8192}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("模型未提供");
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
 * 越线时给琥珀色警示并给出行动（新建对话 / 换更大窗口的模型）。
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
    const threshold = document.querySelector('[style*="left: 87.2%"]');
    expect(threshold).not.toBeNull();
    // 未越线：没有警示文案
    expect(dialog).not.toHaveTextContent("已越过输出预留线");
  });

  it("越过预留线：琥珀警示 + 给出行动（新建对话 / 换更大窗口的模型）", async () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 950_000, outputTokens: 1200 }}
        contextWindow={1_000_000}
        maxOutputTokens={128_000}
      />,
    );
    const dialog = await openPopover();
    expect(dialog).toHaveTextContent("已越过输出预留线");
    expect(dialog).toHaveTextContent("新建对话");
    expect(dialog).toHaveTextContent("窗口更大的模型");
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
 * 容量圆环的读法（用户口径：「圆圈要和百分比对应」「不是随便展示的」）。
 *
 * 四轮纠偏的结论：弧 = **已用百分比**（与浮层里那个百分比同一个数，4.5% 就是一小段弧），
 * **没有数据时只画空环**（不编圆弧）；环 16px 外径 / 3px 描边（**加粗只往里长**，外沿不动），
 * 环里不写数字。
 */
describe("ContextUsageButton：圆环读法", () => {
  const arcs = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll("button[aria-label='上下文容量'] circle"),
    );

  it("弧长 = 已用百分比（4.5% 就是一小段，不是「几乎满环」）", () => {
    const { container } = render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const circles = arcs(container);
    expect(circles).toHaveLength(2);
    // 周长按半径推导（**别写死数字**：改粗细会一起变，写死只会挡住改版）
    const radius = Number(circles[0]?.getAttribute("r"));
    const [arcLen, total] = (
      circles[1]?.getAttribute("stroke-dasharray") ?? ""
    ).split(" ");
    expect(Number(total)).toBeCloseTo(2 * Math.PI * radius, 3);
    expect(Number(arcLen) / Number(total)).toBeCloseTo(0.045, 2);
  });

  it("加粗只往里长：外沿恒在 16px 盒边（r + stroke/2 = 8）", () => {
    const { container } = render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const [track] = arcs(container);
    const radius = Number(track?.getAttribute("r"));
    const stroke = Number(track?.getAttribute("stroke-width"));
    expect(stroke).toBe(3);
    expect(radius + stroke / 2).toBeCloseTo(8, 5);
  });

  it("61.4% 用量：弧占六成多（与浮层读数同一口径）", () => {
    const { container } = render(
      <ContextUsageButton
        usage={{ inputTokens: 614_000, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const circles = arcs(container);
    const [arcLen, total] = (
      circles[1]?.getAttribute("stroke-dasharray") ?? ""
    ).split(" ");
    expect(Number(arcLen) / Number(total)).toBeCloseTo(0.614, 2);
  });

  it("没有用量数据：只画空环（不编圆弧）", () => {
    const { container } = render(
      <ContextUsageButton usage={null} contextWindow={1_000_000} />,
    );
    expect(arcs(container)).toHaveLength(1);
  });

  it("环里不写百分比（读数留在 title 与浮层，且是两位精度的那份）", () => {
    render(
      <ContextUsageButton
        usage={{ inputTokens: 45_300, outputTokens: 1 }}
        contextWindow={1_000_000}
      />,
    );
    const button = screen.getByRole("button", { name: "上下文容量" });
    expect(button.textContent?.trim()).toBe("");
    expect(button.getAttribute("title")).toContain("4.5万/100万（4.53%）");
  });
});
