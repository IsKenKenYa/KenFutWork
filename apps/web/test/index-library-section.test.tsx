// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexLibrarySection } from "../src/components/workbench/index-library-section";

/**
 * 设置 → 索引库（R4-3）按参考图（`docs/参考图/索引库-代码库索引开关.png`）排成
 * **两行开关**，两行都是真行为：
 * ① 「索引新文件夹」= 自动为尚无索引的工作目录建索引（文件数 < 50,000）；
 * ② 「索引存储库以实现即时搜索（测试版）」= 搜索走索引。
 *
 * 这一层锁接线：各行文案与各点各的回调（**不能串**——串了就是「点一个开关改另一个设置」
 * 这类静默错），以及没绑工作目录时的空态。
 * 文案口径 2026-09-27 起改为「只写标签」（AGENTS.md「界面文案（硬约束）」）：
 * 原先按参考图写的整句说明（含 50,000 与「数据保存在本地」那段）已删。
 */
const fetchCodeIndex = vi.fn();

vi.mock("../src/lib/server-api.js", () => ({
  fetchCodeIndex: (...args: unknown[]) => fetchCodeIndex(...args),
  rebuildCodeIndex: vi.fn(),
  clearCodeIndex: vi.fn(),
}));

function renderSection(
  props: Partial<React.ComponentProps<typeof IndexLibrarySection>> = {},
) {
  const onToggle = vi.fn(async () => {});
  const onToggleAuto = vi.fn(async () => {});
  render(
    <IndexLibrarySection
      accessToken="tok"
      canvasId="c1"
      enabled={false}
      autoNewFolder={true}
      onToggle={onToggle}
      onToggleAuto={onToggleAuto}
      {...props}
    />,
  );
  return { onToggle, onToggleAuto };
}

describe("索引库设置：两个开关", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCodeIndex.mockResolvedValue({
      enabled: false,
      autoNewFolder: true,
      stats: null,
    });
  });
  afterEach(cleanup);

  it("两行按参考图文案渲染（含 50,000 与本地索引说明）", () => {
    renderSection();
    expect(screen.getByText("代码库")).toBeVisible();
    expect(screen.getByRole("switch", { name: "索引新文件夹" })).toBeVisible();
    expect(screen.getByText("新文件夹自动索引")).toBeVisible();
    expect(
      screen.getByRole("switch", {
        name: "索引存储库以实现即时搜索（测试版）",
      }),
    ).toBeVisible();
    expect(screen.getByText("仓库自动索引")).toBeVisible();
  });

  it("点第一行只改「索引新文件夹」，第二行只改「即时搜索」（不串）", async () => {
    const { onToggle, onToggleAuto } = renderSection();
    await userEvent.click(screen.getByRole("switch", { name: "索引新文件夹" }));
    expect(onToggleAuto).toHaveBeenCalledWith(false);
    expect(onToggle).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("switch", {
        name: "索引存储库以实现即时搜索（测试版）",
      }),
    );
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onToggleAuto).toHaveBeenCalledTimes(1);
  });

  it("两个开关的当前值各自反映在 switch 上", () => {
    renderSection({ enabled: true, autoNewFolder: false });
    expect(
      screen.getByRole("switch", { name: "索引新文件夹" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", {
        name: "索引存储库以实现即时搜索（测试版）",
      }),
    ).toBeChecked();
  });

  it("没绑工作目录：空态标签 + 不给「清空」（重建仍可点，服务端会如实拒绝无目录）", () => {
    renderSection({ canvasId: null });
    expect(screen.getByText("未绑定工作目录")).toBeVisible();
    expect(screen.getByRole("button", { name: "清空" })).toBeDisabled();
  });

  it("自动建关着时，空态指路「重建索引」而不是说会自动建", () => {
    renderSection({ autoNewFolder: false, enabled: true });
    expect(screen.getByText(/点「重建索引」/)).toBeVisible();
  });
});
