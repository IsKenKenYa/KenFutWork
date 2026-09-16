// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComposerCompactSelect,
  THINKING_OPTIONS,
  TIER_OPTIONS,
} from "../src/components/workbench/composer-compact-select";

/**
 * composer 的图标下拉（用户口径：右侧面板拉大、对话列塞不下时，思考强度与权限改成图标）。
 *
 * 收起文字的判据走 **CSS 容器查询**（浏览器排版时算，不等 JS 事件），所以这里锁的是：
 * 文字节点带着「容器窄于 36rem 就隐藏」的变体类、title 始终交代当前值、下拉照常可选。
 */
describe("ComposerCompactSelect", () => {
  afterEach(cleanup);

  const icon = <span data-testid="control-icon" />;

  it("完整形态：显示当前值的文字，并给出控件名 + 当前值的 title", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        options={TIER_OPTIONS}
        value="full-access"
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText("权限档位");
    expect(trigger).toHaveTextContent("完全访问");
    expect(trigger).toHaveAttribute("title", "权限档位：完全访问");
    expect(within(trigger).getByTestId("control-icon")).toBeInTheDocument();
  });

  it("窄列收起文字：靠容器查询变体类，不靠 JS 量宽度", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        options={TIER_OPTIONS}
        value="default"
        onChange={() => {}}
      />,
    );
    // SelectValue 渲染出的值节点必须带 `@max-xl/composer:hidden`：
    // 少了它，面板拉宽挤窄对话列时文字不会收起（本轮用户反馈的原始问题）
    const value = screen.getByLabelText("权限档位").querySelector(
      '[data-slot="select-value"]',
    );
    expect(value).not.toBeNull();
    expect(value?.className).toContain("@max-xl/composer:hidden");
  });

  it("下拉仍可选：选中后回调新值", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="default"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    await user.click(await screen.findByRole("option", { name: "高" }));
    expect(onChange).toHaveBeenCalledWith("高");
  });

  it("选中当前值不触发回调（不白跑一次设置写入）", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="中"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    await user.click(await screen.findByRole("option", { name: "中" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("值不在选项表里时 title 回落到原值（不吞掉显示）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        options={THINKING_OPTIONS}
        value="自定义档"
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("思考强度")).toHaveAttribute(
      "title",
      "思考强度：自定义档",
    );
  });
});
