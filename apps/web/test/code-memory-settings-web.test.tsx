import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { MemorySettingsSection } from "@zui/settings/MemorySettingsSection";
import { afterEach, expect, it, vi } from "vitest";
import { createWebPlatform } from "../src/components/workbench/zcode/host/upstream/browserPlatform";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const workspace = {
  id: "22222222-2222-4222-8222-222222222222",
  label: "演示项目",
  updatedAt: Date.now(),
  files: [
    {
      name: "MEMORY.md",
      path: "C:/data/memories/projects/p1/memory/MEMORY.md",
      kind: "index" as const,
      size: 20,
      updatedAt: Date.now(),
    },
  ],
};

function renderSection() {
  const readProjectMemoryFile = vi.fn(async () => ({
    content: "# 索引\n- [结论甲](a.md) — 说明\n",
    updatedAt: Date.now(),
  }));
  render(
    <PlatformProvider platform={createWebPlatform()}>
      <TooltipProvider>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <MemorySettingsSection
            memoryEnabled
            memoryService={{
              listProjectMemories: async () => [workspace],
              readProjectMemoryFile,
              listTrashedMemories: async () => [],
              restoreTrashedMemory: async () => ({ fileName: null }),
            }}
            onMemoryEnabledChange={async () => {}}
            projectMemoryViewerAvailable
            workspaceDisplayNames={["演示项目"]}
          />
        </ZCodeIntlProvider>
      </TooltipProvider>
    </PlatformProvider>,
  );
  return { readProjectMemoryFile };
}

// Web 端没有已安装的编辑器按钮，文件列表此前只能看不能读；这里锁死「点开即可读」。
it("Web 端可用：记忆文件名可点开并显示正文", async () => {
  const { readProjectMemoryFile } = renderSection();

  const trigger = await screen.findByRole("button", { name: "MEMORY.md" });
  fireEvent.click(trigger);

  await waitFor(() =>
    expect(readProjectMemoryFile).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      fileName: "MEMORY.md",
    }),
  );
  expect(await screen.findByText(/结论甲/)).toBeTruthy();
});

it("读取失败时透出真实原因，不留空白", async () => {
  render(
    <PlatformProvider platform={createWebPlatform()}>
      <TooltipProvider>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <MemorySettingsSection
            memoryEnabled
            memoryService={{
              listProjectMemories: async () => [workspace],
              readProjectMemoryFile: async () => {
                throw new Error("记忆功能已关闭，请先在设置里打开。");
              },
              listTrashedMemories: async () => [],
              restoreTrashedMemory: async () => ({ fileName: null }),
            }}
            onMemoryEnabledChange={async () => {}}
            projectMemoryViewerAvailable
            workspaceDisplayNames={["演示项目"]}
          />
        </ZCodeIntlProvider>
      </TooltipProvider>
    </PlatformProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "MEMORY.md" }));
  expect(
    await screen.findByText("记忆功能已关闭，请先在设置里打开。"),
  ).toBeTruthy();
});

it("服务可用时不显示「仅桌面端可用」占位", async () => {
  renderSection();
  await screen.findByRole("button", { name: "MEMORY.md" });
  expect(screen.queryByText("仅桌面端可用")).toBeNull();
});
