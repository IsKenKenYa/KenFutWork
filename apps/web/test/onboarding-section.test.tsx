// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OnboardingSection } from "../src/components/workbench/onboarding-section";

/**
 * 设置 → 引导（R5-2）。
 *
 * 用户口径 2026-09-27（第二次因同一页反馈：「排版很乱！！！！还是很啰嗦，而且排版很不合理」）：
 * ① **不写副标题**——四步的标题本身就是动作，「供应商里填 Key 与模型」只是把「接入模型」
 *    换个说法再说一遍；一行说明都没有，四行才是同一个样子。
 * ② **未完成的每一步都要有「去处理」**——原来「绑定工作目录」「发第一条消息」右侧是空的
 *    （`tab: null`），用户看到一张卡片却不知道该干什么。
 * ③ 因此行高一致：尾槽只有「已完成」（绿字）或「去处理」（按钮）两种形态，且都不高于
 *    序号圆点；不再出现「有的行 40px 有的行 38px」。
 *
 * 这里锁 ①② —— 行高要靠真机量（jsdom 没有布局），见台账六十六·补3。
 */
const providerInstances = vi.fn();
const workspaceSettings = vi.fn();
const permissionSettings = vi.fn();

vi.mock("@/lib/server-api", () => ({
  fetchProviderInstances: (...args: unknown[]) => providerInstances(...args),
  fetchWorkspaceSettings: (...args: unknown[]) => workspaceSettings(...args),
  fetchPermissionSettings: (...args: unknown[]) => permissionSettings(...args),
}));

function mount({
  providerCount = 0,
  permissionTier = "default",
  hasWorkDir = false,
  conversationCount = 0,
} = {}) {
  providerInstances.mockResolvedValue({
    instances: Array.from({ length: providerCount }, (_, i) => ({
      id: `p${i}`,
    })),
  });
  workspaceSettings.mockResolvedValue({ defaultModel: "m" });
  permissionSettings.mockResolvedValue({ tier: permissionTier });
  const onGoToTab = vi.fn();
  const onLeaveSettings = vi.fn();
  render(
    <OnboardingSection
      accessToken="t"
      hasWorkDir={hasWorkDir}
      conversationCount={conversationCount}
      onGoToTab={onGoToTab}
      onLeaveSettings={onLeaveSettings}
    />,
  );
  return { onGoToTab, onLeaveSettings };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("设置 → 引导", () => {
  it("四步只写标题：复述标题的副标题不许存在", async () => {
    mount();
    for (const title of [
      "接入模型",
      "绑定工作目录",
      "选权限档位",
      "发第一条消息",
    ]) {
      expect(await screen.findByText(title)).toBeVisible();
    }
    for (const gone of [
      "供应商里填 Key 与模型",
      "Code 模式选一个工作目录",
      "权限里设好档位",
      "发一句试试",
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("每一行只有一行文字（标题），没有第二行灰字", async () => {
    mount();
    const row = (await screen.findByText("接入模型")).closest("li");
    expect(row).not.toBeNull();
    // li 的文本 = 序号/勾 + 标题 + 右侧状态，不含任何副标题
    expect(row?.textContent).toBe("1接入模型去处理");
  });

  it("未完成的每一步都有「去处理」（原来两步右侧是空的）", async () => {
    mount();
    await screen.findByText("接入模型");
    expect(screen.getAllByRole("button", { name: "去处理" })).toHaveLength(4);
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("目标是设置页：点「去处理」切到对应页", async () => {
    const { onGoToTab, onLeaveSettings } = mount();
    await screen.findByText("接入模型");
    const [provider] = screen.getAllByRole("button", { name: "去处理" });
    if (!provider) throw new Error("没有渲染出「去处理」按钮");
    await userEvent.click(provider);
    expect(onGoToTab).toHaveBeenCalledWith("providers");
    expect(onLeaveSettings).not.toHaveBeenCalled();
  });

  it("目标不在设置里（绑目录）：点「去处理」离开设置，不切页", async () => {
    const { onGoToTab, onLeaveSettings } = mount();
    await screen.findByText("绑定工作目录");
    const buttons = screen.getAllByRole("button", { name: "去处理" });
    // 第二行 = 绑定工作目录
    const workdir = buttons[1];
    if (!workdir) throw new Error("第二行没有「去处理」按钮");
    await userEvent.click(workdir);
    expect(onLeaveSettings).toHaveBeenCalledTimes(1);
    expect(onGoToTab).not.toHaveBeenCalled();
  });

  it("做完的步骤显示「已完成」，且不再给「去处理」", async () => {
    mount({
      providerCount: 1,
      permissionTier: "auto-approve",
      hasWorkDir: true,
      conversationCount: 2,
    });
    await screen.findByText("接入模型");
    expect(screen.getAllByText("已完成")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "去处理" })).toBeNull();
  });

  it("读不到状态时如实报错，不留空清单", async () => {
    providerInstances.mockRejectedValue(new Error("boom"));
    workspaceSettings.mockResolvedValue(null);
    permissionSettings.mockResolvedValue({ tier: "default" });
    render(
      <OnboardingSection
        accessToken="t"
        hasWorkDir={false}
        conversationCount={0}
        onGoToTab={vi.fn()}
        onLeaveSettings={vi.fn()}
      />,
    );
    expect(await screen.findByText("读取状态失败，请稍后重试。")).toBeVisible();
  });
});
