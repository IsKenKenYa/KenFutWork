import { expect, type FrameLocator, type Page } from "@playwright/test";

export const WORKBENCH_FRAME = 'iframe[title="Code 工作台"]';
export const MANAGEMENT_FRAME = 'iframe[src*="document=management"]';

/** 设置导航在 Web 实例下实际出现的分区（命令、钩子保持隐藏）。 */
export const SETTINGS_SECTIONS = [
  "常规",
  "外观",
  "模型设置",
  "语音",
  "浏览器控制",
  "键盘快捷键",
  "记忆",
  "权限",
  "子智能体",
  "插件·MCP·技能",
  "使用统计",
  "归档管理",
  "关于",
] as const;

export function workbenchFrame(page: Page): FrameLocator {
  return page.frameLocator(WORKBENCH_FRAME);
}

export function managementFrame(page: Page): FrameLocator {
  return page.frameLocator(MANAGEMENT_FRAME);
}

/** 点工作台侧栏的设置按钮，等新挂载的管理 iframe 出现导航。 */
export async function openSettings(page: Page): Promise<FrameLocator> {
  // 管理 iframe 在页面里预挂载但隐藏，必须点侧栏设置按钮才会显示。
  await workbenchFrame(page)
    .locator('[data-testid="task-settings-button"]')
    .click();
  const management = managementFrame(page);
  await management
    .getByRole("navigation", { name: "主要项" })
    .waitFor({ timeout: 90_000 });
  return management;
}

export async function openSettingsSection(
  page: Page,
  label: string,
): Promise<FrameLocator> {
  const management = await openSettings(page);
  await management
    .getByRole("navigation", { name: "主要项" })
    .getByRole("button", { name: label, exact: true })
    .click();
  return management;
}

/**
 * 设置行：标签在左、控件在右，行容器以 `border-t` 分隔。
 * 用标签文本取最近的 `border-t` 祖先，再在行内找控件，避免误点其他分组的同名按钮。
 */
export function settingsRow(
  management: FrameLocator,
  label: string,
): ReturnType<FrameLocator["locator"]> {
  return management
    .locator("main")
    .getByText(label, { exact: true })
    .first()
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-t ')][1]",
    );
}

export function settingsNav(management: FrameLocator, label: string) {
  return management
    .getByRole("navigation", { name: "主要项" })
    .getByRole("button", { name: label, exact: true });
}

/**
 * 清空实例里已保存的 MCP 服务器，让空态与增删流程可重复运行。
 * 走设置页的真实删除流程：MCP 连接绑定 Code 会话，直接拿令牌调 RPC 会 404。
 */
export async function clearMcpServers(page: Page): Promise<void> {
  const management = await openSettingsSection(page, "插件·MCP·技能");
  await management.getByRole("tab", { name: /MCP/ }).first().click();
  for (let guard = 0; guard < 10; guard += 1) {
    const rows = management
      .getByRole("tabpanel")
      .getByRole("button", { name: /stdio · |http · / });
    // MCP 列表由服务端异步返回；给首屏一次明确的等待窗口，空列表才结束清理。
    try {
      await rows.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      return;
    }
    await rows.first().click();
    await management
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await management
      .getByRole("button", { name: /确认删除/ })
      .click();
    await management
      .getByRole("tabpanel")
      .getByRole("button", { name: "刷新", exact: true })
      .waitFor({ state: "visible" });
  }
}

/** 等设置页自身渲染完成（主标题是分区名）。 */
export async function expectSectionTitle(
  management: FrameLocator,
  title: string,
): Promise<void> {
  await expect(
    management.locator("main").getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}
