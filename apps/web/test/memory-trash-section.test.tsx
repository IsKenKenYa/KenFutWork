import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

type TrashItem = {
  trashId: string;
  fileName: string | null;
  title: string | null;
  reason: "duplicate" | "orphan" | "dangling-index";
  trashedAt: number;
  restorable: boolean;
};

const { MemoryTrashSection } = await import(
  "../src/components/workbench/zcode/settings/MemoryTrashSection.js"
);

const user = userEvent.setup();

const TRASH: TrashItem[] = [
  {
    trashId: "1700000000-abcdef12",
    fileName: "b.md",
    title: "结论乙",
    reason: "duplicate" as const,
    trashedAt: 1_700_000_000_000,
    restorable: true,
  },
  {
    trashId: "1700000000-12345678",
    fileName: "old.md",
    title: "旧结论",
    reason: "orphan" as const,
    trashedAt: 1_700_000_000_000,
    restorable: false,
  },
];

function createService(overrides?: {
  list?: () => Promise<TrashItem[]>;
  restore?: () => Promise<{ fileName: string | null }>;
}) {
  return {
    listTrashedMemories: vi.fn(overrides?.list ?? (async () => TRASH)),
    restoreTrashedMemory: vi.fn(
      overrides?.restore ?? (async () => ({ fileName: "b-restored.md" })),
    ),
  };
}

afterEach(() => {
  cleanup();
});

it("列出时间、标题、原因与可恢复状态", async () => {
  const service = createService();
  render(<MemoryTrashSection projectId="project-1" memoryService={service} />);

  await waitFor(() =>
    expect(screen.getByTestId("memory-trash-list")).toBeTruthy(),
  );
  expect(screen.getByText("结论乙")).toBeTruthy();
  expect(screen.getByText("旧结论")).toBeTruthy();
  expect(screen.getByText(/重复合并/)).toBeTruthy();
  expect(screen.getByText(/孤立正文/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "恢复" })).toBeTruthy();
  expect(screen.getByText("已过可恢复窗口")).toBeTruthy();
  expect(service.listTrashedMemories).toHaveBeenCalledWith({
    projectId: "project-1",
  });
});

it("恢复后展示结果并刷新列表", async () => {
  const service = createService();
  render(<MemoryTrashSection projectId="project-1" memoryService={service} />);

  await user.click(await screen.findByRole("button", { name: "恢复" }));
  expect(service.restoreTrashedMemory).toHaveBeenCalledWith({
    projectId: "project-1",
    trashId: "1700000000-abcdef12",
  });
  await waitFor(() =>
    expect(screen.getByText("已恢复为 b-restored.md")).toBeTruthy(),
  );
  expect(service.listTrashedMemories).toHaveBeenCalledTimes(2);
});

it("索引行恢复没有文件名时给出索引结果", async () => {
  const service = createService({
    list: async () => [
      {
        ...TRASH[0]!,
        trashId: "1700000000-index",
        fileName: null,
        title: "已删除",
        reason: "dangling-index",
        restorable: true,
      },
    ],
    restore: async () => ({ fileName: null }),
  });
  render(<MemoryTrashSection projectId="project-1" memoryService={service} />);

  await user.click(await screen.findByRole("button", { name: "恢复" }));
  await waitFor(() => expect(screen.getByText("索引行已恢复")).toBeTruthy());
});

it("列表读取失败时给出原因并可重读", async () => {
  const service = createService({
    list: vi
      .fn()
      .mockRejectedValueOnce(new Error("记忆功能已关闭"))
      .mockResolvedValueOnce(TRASH),
  });
  render(<MemoryTrashSection projectId="project-1" memoryService={service} />);

  await waitFor(() => expect(screen.getByText("记忆功能已关闭")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(screen.getByTestId("memory-trash-list")).toBeTruthy(),
  );
});

it("不可恢复的条目没有恢复按钮", async () => {
  const service = createService({
    list: async () => [TRASH[1]!],
  });
  render(<MemoryTrashSection projectId="project-1" memoryService={service} />);

  await waitFor(() =>
    expect(screen.getByTestId("memory-trash-list")).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  expect(screen.getByText("已过可恢复窗口")).toBeTruthy();
});
