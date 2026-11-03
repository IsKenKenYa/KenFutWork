import { expect, test } from "@playwright/test";

import { openWorkbench } from "../support/local-access";
import {
  SETTINGS_SECTIONS,
  clearMcpServers,
  expectSectionTitle,
  managementFrame,
  openSettings,
  openSettingsSection,
  settingsRow,
} from "../support/settings";

test.describe("设置页分区与控件", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await openWorkbench(page);
    await clearMcpServers(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
  });

  test("导航只出现 Web 实例可用的 13 个分区，命令与钩子保持隐藏", async ({
    page,
  }) => {
    const management = await openSettings(page);
    const nav = management.getByRole("navigation", { name: "主要项" });
    for (const label of SETTINGS_SECTIONS) {
      await expect(
        nav.getByRole("button", { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(
      nav.getByRole("button", { name: "命令", exact: true }),
    ).toHaveCount(0);
    await expect(
      nav.getByRole("button", { name: "钩子", exact: true }),
    ).toHaveCount(0);
  });

  test("常规分区列出语言、终端、代理、通知与自动压缩控件", async ({
    page,
  }) => {
    const management = await openSettingsSection(page, "常规");
    await expectSectionTitle(management, "常规");
    await expect(
      management.locator('input[placeholder^="留空则内置浏览器跟随系统代理"]'),
    ).toBeVisible();
    await expect(
      management.locator('input[placeholder^="例如 localhost,127.0.0.1"]'),
    ).toBeVisible();
    await expect(
      management.locator(
        'input[placeholder^="例如 /Users/name/certs/root-ca.pem"]',
      ),
    ).toBeVisible();
    await expect(
      settingsRow(management, "继承系统终端 Profile").getByRole("switch"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "任务通知").getByRole("switch"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "自动归档旧任务").getByRole("switch"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "归档保留时长").getByRole("combobox"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "上下文自动压缩").getByRole("switch"),
    ).toBeVisible();
  });

  test("外观分区提供界面主题与代码设置", async ({ page }) => {
    const management = await openSettingsSection(page, "外观");
    await expectSectionTitle(management, "外观");
    await expect(
      management.getByText("界面设置", { exact: true }),
    ).toBeVisible();
    await expect(
      management.getByText("代码设置", { exact: true }),
    ).toBeVisible();
    await expect(
      settingsRow(management, "界面主题").getByRole("combobox"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "显示行号").getByRole("switch"),
    ).toBeVisible();
    await expect(
      settingsRow(management, "长行自动换行").getByRole("switch"),
    ).toBeVisible();
  });

  test("模型设置分区提供添加供应商入口", async ({ page }) => {
    const management = await openSettingsSection(page, "模型设置");
    await expectSectionTitle(management, "模型设置");
    await expect(
      management.getByTestId("model-provider-add-provider-button"),
    ).toBeVisible();
  });

  test("语音分区提供听想说档位与检测入口", async ({ page }) => {
    const management = await openSettingsSection(page, "语音");
    await expectSectionTitle(management, "语音");
    const voice = management.locator('section[aria-label="语音"]');
    await expect(voice).toBeVisible();
    await expect(voice.getByText("只转文本", { exact: true }).first()).toBeVisible();
    await expect(voice.getByText("完整回路", { exact: true }).first()).toBeVisible();
    await expect(
      voice.getByRole("button", { name: "重新检测", exact: true }),
    ).toBeVisible();
    await expect(
      voice.getByRole("button", { name: "应用推荐", exact: true }),
    ).toBeVisible();
  });

  test("浏览器控制在 Web 平台不出现数据清理入口", async ({ page }) => {
    const management = await openSettingsSection(page, "浏览器控制");
    await expectSectionTitle(management, "浏览器控制");
    for (const label of [
      "允许 AI 控制浏览器",
      "自动截图",
      "无头浏览器",
      "允许 AI 读取开发者工具数据",
      "允许 AI 在页面执行脚本",
    ]) {
      await expect(
        settingsRow(management, label).getByRole("switch"),
      ).toBeVisible();
    }
    await expect(
      management.getByRole("button", { name: "连接到 Chrome", exact: true }),
    ).toBeVisible();
    // 内置浏览器数据清理是桌面端能力，Web 宿主不渲染这些入口。
    await expect(
      management.getByRole("button", { name: "清除缓存", exact: true }),
    ).toHaveCount(0);
    await expect(
      management.getByRole("button", { name: "清除全部", exact: true }),
    ).toHaveCount(0);
  });

  test("键盘快捷键分区逐条列出可重新录制的命令", async ({ page }) => {
    const management = await openSettingsSection(page, "键盘快捷键");
    await expectSectionTitle(management, "键盘快捷键");
    await expect(
      management
        .getByRole("button", {
          name: "重新录制「切换深色/浅色主题」快捷键",
        })
        .first(),
    ).toBeVisible();
    await expect(
      management
        .getByRole("button", {
          name: "重新录制「打开命令中心」快捷键",
        })
        .first(),
    ).toBeVisible();
  });

  test("记忆分区提供工作区记忆开关", async ({ page }) => {
    const management = await openSettingsSection(page, "记忆");
    await expectSectionTitle(management, "记忆");
    await expect(
      management.locator('[data-testid="settings-memory-switch"]'),
    ).toBeVisible();
  });

  test("权限分区展示审批模型设置", async ({ page }) => {
    const management = await openSettingsSection(page, "权限");
    await expectSectionTitle(management, "权限");
    await expect(management.locator('section[aria-label="审批"]')).toBeVisible();
  });

  test("子智能体分区只读展示内置清单", async ({ page }) => {
    const management = await openSettingsSection(page, "子智能体");
    await expectSectionTitle(management, "子智能体");
    await expect(
      management.getByText("当前阶段用户级子智能体仅支持桌面端。"),
    ).toBeVisible();
    await expect(
      management.getByText("内置子智能体", { exact: true }),
    ).toBeVisible();
    for (const agent of ["代码调研", "代码审查", "规划拆解", "批量出图", "视频生成"]) {
      await expect(
        management.getByText(agent, { exact: true }).first(),
      ).toBeVisible();
    }
    await expect(
      management.getByRole("button", { name: "新建子智能体", exact: true }),
    ).toHaveCount(0);
  });

  test("插件·MCP·技能分区提供三个标签页与空态", async ({ page }) => {
    const management = await openSettingsSection(page, "插件·MCP·技能");
    await expectSectionTitle(management, "插件·MCP·技能");
    await expect(management.getByRole("tab", { name: /插件/ }).first()).toBeVisible();
    await expect(management.getByRole("tab", { name: /MCP/ }).first()).toBeVisible();
    await expect(management.getByRole("tab", { name: /技能/ }).first()).toBeVisible();

    await management.getByRole("tab", { name: /插件/ }).first().click();
    await expect(
      management.getByText("尚未安装插件", { exact: true }),
    ).toBeVisible();

    await management.getByRole("tab", { name: /MCP/ }).first().click();
    await expect(
      management.getByText("尚未安装 MCP 服务器", { exact: true }),
    ).toBeVisible();
    await expect(
      management.getByRole("button", { name: "新建 MCP 服务器", exact: true }),
    ).toBeVisible();

    await management.getByRole("tab", { name: /技能/ }).first().click();
    await expect(
      management.getByText("尚未安装技能", { exact: true }),
    ).toBeVisible();
    await expect(
      management.getByRole("button", { name: "新建技能", exact: true }),
    ).toBeVisible();
  });

  test("使用统计分区展示应用用量标签与空态", async ({ page }) => {
    const management = await openSettingsSection(page, "使用统计");
    await expectSectionTitle(management, "使用统计");
    await expect(
      management.getByRole("button", { name: "应用用量", exact: true }),
    ).toBeVisible();
    await expect(
      management.getByText("还没有可展示的数据", { exact: true }).first(),
    ).toBeVisible();
  });

  test("归档管理分区如实展示读取状态", async ({ page }) => {
    const management = await openSettingsSection(page, "归档管理");
    await expectSectionTitle(management, "归档管理");
    const empty = management.getByText("暂无已归档会话", { exact: true });
    const failed = management.getByText("无法读取归档会话", { exact: true });
    await expect(empty.or(failed)).toBeVisible();
  });

  test("关于分区展示版本与法律文档", async ({ page }) => {
    const management = await openSettingsSection(page, "关于");
    await expectSectionTitle(management, "关于");
    await expect(
      management.getByText("BYOK 的 AI 工作台", { exact: true }),
    ).toBeVisible();
    await expect(
      management.getByText("kenfutwork-server · v0.0.0", { exact: true }),
    ).toBeVisible();
    await expect(
      management.getByRole("link", { name: "最终用户许可协议", exact: true }),
    ).toBeVisible();
    // Web 宿主没有桌面更新通道，不显示无法使用的检查更新入口。
    await expect(
      management.getByRole("button", { name: "检查更新", exact: true }),
    ).toHaveCount(0);
  });

  test("管理模式第二个 iframe 挂载且保持工作台外壳", async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('iframe[title="Code 工作台"]')).toBeVisible();
    await expect(
      page.locator('iframe[src*="document=management"]'),
    ).toBeVisible();
    await expect(
      managementFrame(page).getByRole("navigation", { name: "主要项" }),
    ).toBeVisible();
  });
});
