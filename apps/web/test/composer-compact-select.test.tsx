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
 * 锁三件事：完整形态显示当前值 → 窄列只剩图标但 title 说清当前值 → 下拉仍能选。
 */
describe("ComposerCompactSelect", () => {
  afterEach(cleanup);

  const icon = <span data-testid="control-icon" />;

  it("完整形态：显示当前值的文字", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        compact={false}
        options={TIER_OPTIONS}
        value="full-access"
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText("权限档位");
    expect(trigger).toHaveTextContent("完全访问");
    expect(within(trigger).getByTestId("control-icon")).toBeInTheDocument();
  });

  it("窄列：只剩图标，当前值改由 title 交代（不留哑图标）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="权限档位"
        icon={icon}
        compact
        options={TIER_OPTIONS}
        value="full-access"
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText("权限档位");
    expect(trigger).not.toHaveTextContent("完全访问");
    expect(trigger).toHaveAttribute("title", "权限档位：完全访问");
    expect(within(trigger).getByTestId("control-icon")).toBeInTheDocument();
  });

  it("窄列下仍能换档：选中后回调新值", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        compact
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
        compact
        options={THINKING_OPTIONS}
        value="中"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    await user.click(await screen.findByRole("option", { name: "中" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("值不在选项表里时不吞掉显示（回落到原值）", () => {
    render(
      <ComposerCompactSelect
        ariaLabel="思考强度"
        icon={icon}
        compact
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
