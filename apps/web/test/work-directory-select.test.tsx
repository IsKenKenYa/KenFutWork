// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ProjectSummary } from "@kenfutwork/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkDirectorySelect } from "../src/components/workbench/work-directory-select";
import { folderPickerHint } from "../src/lib/work-directory.js";

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

/**
 * 「填本机路径」入口已移除（用户口径）：底部只剩「打开文件夹」「不在项目中工作」，
 * 绝对路径绑定只走桌面「打开文件夹」的系统对话框链路。空态提示只说「还没有工作目录」。
 */
describe("WorkDirectorySelect：入口收敛", () => {
  it("没有「填本机路径」入口，也没有手填路径表单", async () => {
    renderSelect();
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(
      screen.queryByRole("button", { name: "填本机路径" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("本机工作目录路径")).not.toBeInTheDocument();
  });

  it("空列表：空态只说「还没有工作目录」", async () => {
    renderSelect({ projects: [], selectedProjectId: null });
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(screen.getByText("还没有工作目录")).toBeVisible();
  });

  it("「不在项目中工作」触发 onClear 并关闭下拉", async () => {
    const { onClear } = renderSelect();
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    await userEvent.click(
      screen.getByRole("button", { name: "不在项目中工作" }),
    );
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("列表里显示已绑定的真实路径（绑定状态可见）", async () => {
    renderSelect({
      projects: [
        {
          ...projects[0],
          workDir: "D:\\Desktop\\test",
        } as ProjectSummary,
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(screen.getByText("D:\\Desktop\\test")).toBeVisible();
  });
});

/**
 * env 映射的生效目录（`GET /api/code/work-dir`）：无项目绑定时不能再显示「未绑定」——
 * agent 实际落在映射目录里。chip 显示目录名，用 FolderSymlink 图标与 title 标出来源。
 */
describe("WorkDirectorySelect：env 映射的生效目录", () => {
  it("未选中 + 有映射：显示映射目录名，title 标出来源", () => {
    renderSelect({
      selectedProjectId: null,
      mappedWorkDir: "D:\\Desktop\\test",
    });
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("test");
    expect(trigger).toHaveAttribute(
      "title",
      "环境变量映射 · D:\\Desktop\\test",
    );
    expect(trigger.querySelector(".lucide-folder-symlink")).not.toBeNull();
  });

  it("锁定（对话未绑项目）也显示映射目录而不是「未绑定」", () => {
    renderSelect({
      selectedProjectId: null,
      mappedWorkDir: "D:\\Desktop\\test",
      lockedHint: "环境变量映射 · D:\\Desktop\\test",
    });
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("test");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      "环境变量映射 · D:\\Desktop\\test",
    );
  });

  it("选中的项目优先于映射（项目名照旧，不显示映射目录）", () => {
    renderSelect({ mappedWorkDir: "D:\\Desktop\\test" });
    const trigger = screen.getByRole("button", { name: "工作目录" });
    expect(trigger).toHaveTextContent("kenfutwork");
    expect(trigger.querySelector(".lucide-folder-symlink")).toBeNull();
  });

  it("映射路径取不出目录名（盘符根）：回退既有占位，不给空 chip", () => {
    renderSelect({
      selectedProjectId: null,
      mappedWorkDir: "D:\\",
      lockedHint: "本次对话没有绑定工作目录",
    });
    expect(screen.getByRole("button", { name: "工作目录" })).toHaveTextContent(
      "未绑定工作目录",
    );
  });
});

/**
 * 「打开文件夹」的副标题：桌面形态走服务端系统对话框（真绑定），其它形态是浏览器选择器
 * （按目录名复用/新建）。说清差别，用户才知道选的目录有没有被用上。
 */
describe("WorkDirectorySelect：打开文件夹的形态说明", () => {
  it("原生对话框可用：副标题写明系统对话框 + 直接绑定", async () => {
    renderSelect({ folderHint: folderPickerHint({ available: true }) });
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(screen.getByText(/系统文件夹对话框/)).toBeVisible();
  });

  it("不可用：副标题写明按目录名复用/新建同名工作目录", async () => {
    renderSelect({ folderHint: folderPickerHint(null) });
    await userEvent.click(screen.getByRole("button", { name: "工作目录" }));
    expect(screen.getByText(/按目录名/)).toBeVisible();
  });
});
