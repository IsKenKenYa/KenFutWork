// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../src/components/workbench/settings-modal";

/**
 * 设置导航里**一个页面只能出现一次**。
 *
 * 历史：为了「参考图里点名的名字也能找到」，导航一度加过跳转别名行
 * （「记忆 → 规则与记忆」「用量管理 → 使用统计」「电脑控制 → 浏览器」）。用户两次口径
 * （「这两个合并为一个菜单」「这个让你合并的东西怎么又出来了」）之后别名行整体下线——
 * 这条测试锁住它不再回来：导航里不许出现「→ 目标页」这种两段式跳转项。
 */
vi.mock("../src/lib/local-instance-context", () => ({
  useLocalInstance: () => ({
    status: "ready",
    instance: { instanceId: "instance", dataDir: "/data" },
  }),
}));

vi.mock("../src/lib/server-api.js", () => ({
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchInstanceSettings: vi.fn(async () => ({ settings: {} })),
  updateInstanceSettings: vi.fn(async () => ({ settings: {} })),
}));

afterEach(cleanup);

describe("设置导航：一个页面只出现一次", () => {
  it("不再有「记忆 → 规则与记忆」「用量管理 → 使用统计」这类跳转别名行", async () => {
    render(<SettingsModal open onClose={() => {}} />);
    const nav = await screen.findByRole("navigation", { name: "设置分类" });
    const labels = Array.from(nav.querySelectorAll("button")).map(
      (button) => button.textContent?.trim() ?? "",
    );

    // 正主都在
    expect(labels).toContain("规则与记忆");
    expect(labels).toContain("使用统计");
    // 别名行（两段式跳转项）必须一个不剩
    expect(labels.filter((label) => label.includes("→"))).toEqual([]);
    expect(labels).not.toContain("记忆");
    expect(labels).not.toContain("用量管理");
    // 默认 general 页随之挂载的终端分区在自行拉取：结束前等它落定，不给
    // 「环境拆除后才 setState」留空窗（CI 实锤过一次 unhandled rejection）。
    await screen.findByLabelText("默认 shell");
  });
});
