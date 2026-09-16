import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  MAX_PANEL_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_PANEL_WIDTH,
  panelWidthLimits,
  SIDEBAR_RAIL_WIDTH,
} from "../src/lib/panel-layout";

/**
 * 三栏宽度口径：面板上限由视口与左栏现算（给中间的对话列留最小宽度），
 * 拖过上限时左栏自动收起来腾地方（`workbench-side-panel.test.tsx` 锁拖动行为）。
 * 窄列下 composer 收成图标是 CSS 容器查询的事，见 `composer-compact-select.test.tsx`。
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
    expect(collapsed.max).toBe(
      1200 - SIDEBAR_RAIL_WIDTH - MIN_CONVERSATION_WIDTH,
    );
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
