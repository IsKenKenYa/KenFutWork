// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageMentionPicker } from "../src/components/canvas-image-picker";

afterEach(cleanup);

/**
 * `@` 提及弹层的键盘行为。
 *
 * 为什么要有这一层：光标留在输入框里，列表只是弹出层——不接键盘的话，用户打完
 * `@demo` 按回车会先把半截「@demo」当消息发出去（真机实测过的坑），所以弹层要在
 * 捕获阶段接管 ↑↓ / 回车 / Esc，并把事件拦下来。
 */
const ITEMS = [
  {
    kind: "skill" as const,
    id: "s1",
    label: "run-hello-py",
    slug: "run-hello-py",
    description: "跑 hello.py",
  },
  {
    kind: "skill" as const,
    id: "s2",
    label: "demo-helper",
    slug: "demo-helper",
    description: "写总结",
  },
];

describe("MessageMentionPicker（@ 列表）", () => {
  it("↑↓ 选、回车确认：把选中项交给 onSelect 并关闭，不落到输入框的发送上", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <MessageMentionPicker
        items={ITEMS}
        query=""
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("默认选中第一项：直接回车就选中第一条", async () => {
    const onSelect = vi.fn();
    render(
      <MessageMentionPicker
        items={ITEMS}
        query=""
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    await userEvent.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("查询词过滤后再回车：选中的是过滤后的那一条", async () => {
    const onSelect = vi.fn();
    render(
      <MessageMentionPicker
        items={ITEMS}
        query="demo"
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    // 只剩 demo-helper 一条，回车应直接选中它
    expect(screen.queryByText("run-hello-py")).toBeNull();
    await userEvent.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("Esc 关闭弹层", async () => {
    const onClose = vi.fn();
    render(
      <MessageMentionPicker
        items={ITEMS}
        query=""
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("没有匹配项时不接回车（保留空态文案，不误选）", async () => {
    const onSelect = vi.fn();
    render(
      <MessageMentionPicker
        items={ITEMS}
        query="zzz"
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("没有匹配「zzz」的条目")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");

    expect(onSelect).not.toHaveBeenCalled();
  });
});
