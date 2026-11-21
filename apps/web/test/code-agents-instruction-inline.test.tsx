import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import {
  AgentsInstructionInline,
  resolveAgentsInstructionPath,
} from "@zui/settings/AgentsInstructionRow";
import { afterEach, expect, it, vi } from "vitest";
import { createWebPlatform } from "../src/components/workbench/zcode/host/upstream/browserPlatform";

type RowPlatform = ReturnType<typeof createWebPlatform>;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** 智能体页头那一段：页签 + 搜索同一行，不再独占一张卡。 */
function renderRow(platform: RowPlatform, workspacePath: string) {
  render(
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <AgentsInstructionInline
          filePath={resolveAgentsInstructionPath(workspacePath)}
        />
      </ZCodeIntlProvider>
    </PlatformProvider>,
  );
}

it("Windows 项目根目录拼出 AGENTS.md 绝对路径", () => {
  expect(resolveAgentsInstructionPath("C:\\work\\demo\\")).toBe(
    "C:\\work\\demo\\AGENTS.md",
  );
  renderRow(createWebPlatform(), "C:\\work\\demo");
  expect(screen.getByText("AGENTS.md")).toBeTruthy();
  expect(screen.getByText("C:\\work\\demo\\AGENTS.md")).toBeTruthy();
});

it("POSIX 路径沿用 / 分隔符，尾部分隔符不重复", () => {
  expect(resolveAgentsInstructionPath("/home/me/proj/")).toBe(
    "/home/me/proj/AGENTS.md",
  );
  renderRow(createWebPlatform(), "/home/me/proj/");
  expect(screen.getByText("/home/me/proj/AGENTS.md")).toBeTruthy();
});

it("用选中的软件打开项目根目录的 AGENTS.md", async () => {
  const openInEditor = vi.fn(async () => ({ success: true }));
  const platform: RowPlatform = {
    ...createWebPlatform(),
    getInstalledEditors: async () => [
      {
        id: "vscode",
        name: "VS Code",
        iconDataUrl: "data:image/png;base64,AA==",
      },
    ],
    openInEditor,
  };
  renderRow(platform, "C:\\work\\demo");

  fireEvent.click(
    await screen.findByRole("button", { name: "在 VS Code 中打开" }),
  );

  await waitFor(() =>
    expect(openInEditor).toHaveBeenCalledWith(
      "vscode",
      "C:\\work\\demo\\AGENTS.md",
      undefined,
    ),
  );
});

it("Web 端没有已安装软件时仍如实显示文件与路径", () => {
  renderRow(createWebPlatform(), "/home/me/proj");
  expect(screen.getByText("AGENTS.md")).toBeTruthy();
  expect(screen.getByText("/home/me/proj/AGENTS.md")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /打开/ })).toBeNull();
});

it("传入 onEdit 时出现页内编辑入口，未传则不出现", () => {
  const onEdit = vi.fn();
  render(
    <PlatformProvider platform={createWebPlatform()}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <AgentsInstructionInline
          filePath="/home/me/proj/AGENTS.md"
          onEdit={onEdit}
        />
      </ZCodeIntlProvider>
    </PlatformProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(onEdit).toHaveBeenCalled();
  cleanup();
  render(
    <PlatformProvider platform={createWebPlatform()}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <AgentsInstructionInline filePath="/home/me/proj/AGENTS.md" />
      </ZCodeIntlProvider>
    </PlatformProvider>,
  );
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
});
