// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  type PluginPanelEntry,
  PluginPanelOverlay,
} from "../src/lib/plugin-panels";

/**
 * 面板标题栏窗控（回归）：2026-10-26 用户口径「最小化/最大化/关闭用通用图标、
 * 不要位移动画、最大化时按钮不变样」。
 *
 * 锁三件事：
 * ① 窗控只有最大化/关闭两个（最小化已按用户要求撤掉），不存在重复的关闭钮；
 * ② 最大化把弹层铺满视口，再点一次还原；
 * ③ 最大化前后按钮图标都是方形（不换成「还原」的双框图标）。
 */
const panel: PluginPanelEntry = {
  id: "ha",
  entryId: "panel",
  pluginId: "bundled__kenfutwork-ha",
  title: "智能家居",
  slot: "sidebar",
  url: "panel.html",
  icon: null,
  configurable: true,
};

afterEach(cleanup);

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-slot=dialog-content]",
  );
  if (!element) throw new Error("面板弹层未渲染");
  return element;
}

describe("插件面板标题栏窗控", () => {
  it("只有最大化与关闭，最大化可还原且图标不变样", () => {
    render(<PluginPanelOverlay panel={panel} onClose={() => {}} />);

    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
    expect(screen.getByRole("button", { name: "配置" })).toBeVisible();

    const maximize = screen.getByRole("button", { name: "最大化" });
    const square = maximize.querySelector("svg");
    expect(square?.getAttribute("class")).toContain("lucide-square");
    expect(dialog().className).not.toContain("h-[100vh]");

    fireEvent.click(maximize);
    expect(dialog().className).toContain("h-[100vh]");
    expect(maximize.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-square",
    );

    fireEvent.click(maximize);
    expect(dialog().className).not.toContain("h-[100vh]");
    expect(dialog().className).toContain("h-[80vh]");
  });
});
