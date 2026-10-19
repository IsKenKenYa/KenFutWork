import { expect, test } from "vitest";
import { SIDE_PANE_DEFAULT_EXPANDED_RATIO } from "../src/components/workbench/zcode/app-shell/sidePaneLayout";

const { parsePanelMaxSizePercent, shouldCollapseSidebarAtPanelMax } =
  await import(
    "../src/components/workbench/zcode/app-shell/animatedSidePanePanelModel.js"
  );

test("parsePanelMaxSizePercent：百分比字符串与数字可解析，px 返回 null", () => {
  expect(parsePanelMaxSizePercent("65%")).toBe(65);
  expect(parsePanelMaxSizePercent(" 65% ")).toBe(65);
  expect(parsePanelMaxSizePercent(42)).toBe(42);
  expect(parsePanelMaxSizePercent("240px")).toBeNull();
  expect(parsePanelMaxSizePercent(0)).toBeNull();
  expect(parsePanelMaxSizePercent(-1)).toBeNull();
});

test("shouldCollapseSidebarAtPanelMax：到上限（含容差抖动）才为真", () => {
  // 拖到上限
  expect(
    shouldCollapseSidebarAtPanelMax({
      panelSizePercent: 65,
      maxSizePercent: 65,
    }),
  ).toBe(true);
  // 边界小数抖动（库在 64.6~65 之间给值）
  expect(
    shouldCollapseSidebarAtPanelMax({
      panelSizePercent: 64.6,
      maxSizePercent: 65,
    }),
  ).toBe(true);
  // 程序化展开的默认值（64%，低于 65% 上限）与普通拖拽都不触发；
  // 默认值一旦等于上限，任何模式打开内容面板都会误收左栏。
  expect(
    shouldCollapseSidebarAtPanelMax({
      panelSizePercent: SIDE_PANE_DEFAULT_EXPANDED_RATIO * 100,
      maxSizePercent: 65,
    }),
  ).toBe(false);
  expect(
    shouldCollapseSidebarAtPanelMax({
      panelSizePercent: 64,
      maxSizePercent: 65,
    }),
  ).toBe(false);
  // 坏输入不炸
  expect(
    shouldCollapseSidebarAtPanelMax({
      panelSizePercent: Number.NaN,
      maxSizePercent: 65,
    }),
  ).toBe(false);
});
