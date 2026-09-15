// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SidePanelTabs,
  type SidePanelTab,
} from "../src/components/side-panel-tabs";

/**
 * 顶部标签栏（会话 / 图层 / 文件）。
 *
 * 它原先挤在右侧面板的标题行里，现提到画布页顶部成为一条真正的多标签栏；
 * 面板内容（对话 / 图层列表 / 生成文件）由画布页按选中标签分发。
 */
describe("画布顶部标签栏", () => {
  afterEach(() => {
    cleanup();
  });

  it("渲染三个标签，并标出当前选中项", () => {
    render(<SidePanelTabs value="layers" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["会话", "图层", "文件"]);
    expect(screen.getByRole("tab", { name: "图层" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "会话" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("点击标签回调新值（受控组件不自持状态）", async () => {
    const onChange = vi.fn();
    render(<SidePanelTabs value="chat" onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: "文件" }));
    expect(onChange).toHaveBeenCalledWith("files");
    // 未受控更新：value 没变，选中态仍停在「会话」
    expect(screen.getByRole("tab", { name: "会话" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("受控使用时点一下即切走", async () => {
    function Harness() {
      const [tab, setTab] = useState<SidePanelTab>("chat");
      return <SidePanelTabs value={tab} onChange={setTab} />;
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("tab", { name: "图层" }));
    expect(screen.getByRole("tab", { name: "图层" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "会话" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
