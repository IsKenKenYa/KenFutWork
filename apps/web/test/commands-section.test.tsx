// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandsSection } from "../src/components/workbench/commands-section";

/**
 * 设置 → 命令（R5-2 的「命令」条目）。
 *
 * 这一页的意义在于它是**真的注册表**：存进工作区设置、由输入框消费（展开逻辑见
 * `lib/slash-commands.ts` 的 7 例单测）。这里锁界面侧：整表保存、前端能立刻给的校验
 * （空名/非法字符/重名/空提示词）、删行。
 */
const updateWorkspaceSettings = vi.fn();
vi.mock("../src/lib/server-api.js", () => ({
  updateWorkspaceSettings: (...args: unknown[]) =>
    updateWorkspaceSettings(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("设置 → 命令", () => {
  it("空表：给出示例，新增一行后可填名/说明/提示词并整表保存", async () => {
    updateWorkspaceSettings.mockResolvedValue({
      settings: {
        commands: [
          { name: "review", description: "审查", prompt: "请审查：{{args}}" },
        ],
      },
    });
    const onSaved = vi.fn();
    render(
      <CommandsSection accessToken="tok" commands={[]} onSaved={onSaved} />,
    );
    expect(screen.getByText(/还没有自定义命令/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /新增命令/ }));
    await userEvent.type(screen.getByLabelText("命令名 1"), "review");
    await userEvent.type(screen.getByLabelText("命令说明 1"), "审查");
    // userEvent.type 把 `{` 当按键语法（`{{` 是转义），提示词里的 `{{args}}` 直接 change 写入
    fireEvent.change(screen.getByLabelText("命令提示词 1"), {
      target: { value: "请审查：{{args}}" },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存命令" }));

    expect(updateWorkspaceSettings).toHaveBeenCalledWith("tok", {
      commands: [
        { name: "review", description: "审查", prompt: "请审查：{{args}}" },
      ],
    });
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText("已保存")).toBeVisible();
  });

  it("非法名字：就地报错，不发请求", async () => {
    render(
      <CommandsSection accessToken="tok" commands={[]} onSaved={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /新增命令/ }));
    await userEvent.type(screen.getByLabelText("命令名 1"), "a/b");
    await userEvent.type(screen.getByLabelText("命令提示词 1"), "x");
    await userEvent.click(screen.getByRole("button", { name: "保存命令" }));
    expect(screen.getByText(/不是合法命令名/)).toBeVisible();
    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("重名：报错（大小写不敏感）", async () => {
    render(
      <CommandsSection
        accessToken="tok"
        commands={[
          { name: "review", description: "", prompt: "a" },
          { name: "Review", description: "", prompt: "b" },
        ]}
        onSaved={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "保存命令" }));
    expect(screen.getByText(/重复/)).toBeVisible();
    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("删行：删除后保存的只剩剩下的那条", async () => {
    updateWorkspaceSettings.mockResolvedValue({
      settings: { commands: [{ name: "keep", description: "", prompt: "p" }] },
    });
    render(
      <CommandsSection
        accessToken="tok"
        commands={[
          { name: "keep", description: "", prompt: "p" },
          { name: "drop", description: "", prompt: "p" },
        ]}
        onSaved={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "删除命令 2" }));
    await userEvent.click(screen.getByRole("button", { name: "保存命令" }));
    expect(updateWorkspaceSettings).toHaveBeenCalledWith("tok", {
      commands: [{ name: "keep", description: "", prompt: "p" }],
    });
  });
});
