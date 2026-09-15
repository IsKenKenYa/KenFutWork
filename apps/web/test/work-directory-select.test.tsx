// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ProjectSummary } from "@kenfutwork/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkDirectorySelect } from "../src/components/workbench/work-directory-select";

/**
 * 对话标题行里的工作目录 chip。
 *
 * 锁定的理由是作用域不变量：一轮 run 的作用域是「对话绑定的项目主画布」
 * （canvasId 同时就是沙箱目录名），对话中途换目录会让上一轮写的文件留在旧沙箱里
 * 「消失」。所以对话视图里这个 chip 只展示、不给下拉（按了不生效才是坑）。
 */
const projects: ProjectSummary[] = [
  {
    id: "p1",
    name: "kenfutwork",
    kind: "code",
    primaryCanvas: { id: "c1", name: "kenfutwork" },
  } as ProjectSummary,
  {
    id: "p2",
    name: "notes",
    kind: "code",
    primaryCanvas: { id: "c2", name: "notes" },
  } as ProjectSummary,
];

function renderSelect(
  props: Partial<React.ComponentProps<typeof WorkDirectorySelect>> = {},
) {
  const onSelect = vi.fn();
  const onOpenFolder = vi.fn();
  const onClear = vi.fn();
  render(
    <WorkDirectorySelect
      projects={projects}
      selectedProjectId="p1"
      onSelect={onSelect}
      onOpenFolder={onOpenFolder}
      onClear={onClear}
      {...props}
    />,
  );
  return { onSelect, onOpenFolder, onClear };
}

afterEach(() => {
  cleanup();
});

describe("WorkDirectorySelect", () => {
  it("默认形态：显示当前目录名，点开有列表与「打开文件夹」", async () => {
    renderSelect();
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("kenfutwork");
    expect(trigger).toBeEnabled();

    await userEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "工作目录列表" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "打开文件夹" }),
    ).toBeInTheDocument();
  });

  it("锁定形态：仍显示目录名，但禁用且不弹下拉（对话作用域不可中途改）", async () => {
    renderSelect({ lockedHint: "本次对话已绑定工作目录「kenfutwork」" });
    const trigger = screen.getByRole("button", { name: "工作目录" });

    expect(trigger).toHaveTextContent("kenfutwork");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      "本次对话已绑定工作目录「kenfutwork」",
    );

    await userEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("锁定且对话没有项目：显示「未绑定工作目录」而不是空白 chip", () => {
    renderSelect({
      selectedProjectId: null,
      lockedHint: "本次对话没有绑定工作目录",
    });
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("未绑定工作目录");
    expect(trigger).toBeDisabled();
  });

  it("未锁定且未选中：显示占位文案并可选择目录", async () => {
    const { onSelect } = renderSelect({ selectedProjectId: null });
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("选择工作目录");

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: /notes/ }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });
});
