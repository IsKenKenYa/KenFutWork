import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  conversationColumnWidth,
  isCompactComposer,
  MAX_PANEL_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_PANEL_WIDTH,
  panelWidthLimits,
  SIDEBAR_RAIL_WIDTH,
  shouldAutoCollapseSidebar,
} from "../src/lib/panel-layout";

/**
 * 三栏宽度口径：面板上限由视口与左栏现算（给中间的对话列留最小宽度），
 * 拖过上限时左栏自动收起来腾地方，对话列窄到控件排不下时 composer 收成图标。
 */
describe("panelWidthLimits", () => {
  it("上限 = 视口 − 左栏 − 对话列最小宽度（正常视口）", () => {
    const limits = panelWidthLimits({
      windowWidth: 1512,
      sidebarWidth: 256,
      sidebarCollapsed: false,
    });
    expect(limits.max).toBe(1512 - 256 - MIN_CONVERSATION_WIDTH);
    expect(limits.min).toBe(MIN_PANEL_WIDTH);
  });

  it("左栏收起时按图标栏宽度算（面板能更宽）", () => {
    const expanded = panelWidthLimits({
      windowWidth: 1200,
      sidebarWidth: 256,
      sidebarCollapsed: false,
    });
    const collapsed = panelWidthLimits({
      windowWidth: 1200,
      sidebarWidth: 256,
      sidebarCollapsed: true,
    });
    expect(collapsed.max).toBe(1200 - SIDEBAR_RAIL_WIDTH - MIN_CONVERSATION_WIDTH);
    expect(collapsed.max).toBeGreaterThan(expanded.max);
  });

  it("视口很大时不超过写死的面板上限", () => {
    expect(
      panelWidthLimits({
        windowWidth: 4000,
        sidebarWidth: 256,
        sidebarCollapsed: true,
      }).max,
    ).toBe(MAX_PANEL_WIDTH);
  });

  it("视口很小时上限不塌到 0（下限优先，对话列由外层保证）", () => {
    expect(
      panelWidthLimits({
        windowWidth: 700,
        sidebarWidth: 256,
        sidebarCollapsed: false,
      }).max,
    ).toBe(MIN_PANEL_WIDTH);
  });

  it("视口未知（SSR）时不施加动态上限", () => {
    expect(
      panelWidthLimits({
        windowWidth: 0,
        sidebarWidth: 256,
        sidebarCollapsed: false,
      }).max,
    ).toBe(MAX_PANEL_WIDTH);
  });
});

describe("clampPanelWidth", () => {
  it("夹在上下限之间", () => {
    expect(clampPanelWidth(120, { min: 280, max: 900 })).toBe(280);
    expect(clampPanelWidth(1200, { min: 280, max: 900 })).toBe(900);
    expect(clampPanelWidth(500, { min: 280, max: 900 })).toBe(500);
  });
});

describe("shouldAutoCollapseSidebar", () => {
  const base = { windowWidth: 1512, sidebarWidth: 256 };

  it("越过上限且左栏能腾地方 → 收起", () => {
    expect(
      shouldAutoCollapseSidebar({ ...base, nextPanelWidth: 900 }),
    ).toBe(true);
  });

  it("没越过上限 → 不动左栏", () => {
    expect(
      shouldAutoCollapseSidebar({ ...base, nextPanelWidth: 700 }),
    ).toBe(false);
  });

  it("左栏已是图标栏（视口小、收起来也没用）→ 不收", () => {
    // 视口小到两种左栏状态下上限都塌到面板下限：收起来什么也换不来。
    expect(
      shouldAutoCollapseSidebar({
        windowWidth: 700,
        sidebarWidth: 256,
        nextPanelWidth: 500,
      }),
    ).toBe(false);
  });
});

describe("conversationColumnWidth", () => {
  it("对话列 = 视口 − 左栏 − 面板", () => {
    expect(
      conversationColumnWidth({
        windowWidth: 1716,
        sidebarWidth: 256,
        sidebarCollapsed: false,
        panelWidth: 720,
      }),
    ).toBe(740);
  });

  it("左栏收起按图标栏算", () => {
    expect(
      conversationColumnWidth({
        windowWidth: 1716,
        sidebarWidth: 256,
        sidebarCollapsed: true,
        panelWidth: 720,
      }),
    ).toBe(1716 - 48 - 720);
  });

  it("面板没开时只扣左栏", () => {
    expect(
      conversationColumnWidth({
        windowWidth: 1512,
        sidebarWidth: 256,
        sidebarCollapsed: false,
        panelWidth: 0,
      }),
    ).toBe(1256);
  });

  it("极窄视口不返回负数", () => {
    expect(
      conversationColumnWidth({
        windowWidth: 600,
        sidebarWidth: 256,
        sidebarCollapsed: false,
        panelWidth: 900,
      }),
    ).toBe(0);
  });
});

describe("isCompactComposer", () => {
  it("窄于阈值收成图标，宽于阈值保持文字", () => {
    expect(isCompactComposer(520)).toBe(true);
    expect(isCompactComposer(760)).toBe(false);
  });

  it("宽度未知（还没量到）不误伤成紧凑", () => {
    expect(isCompactComposer(null)).toBe(false);
  });
});
