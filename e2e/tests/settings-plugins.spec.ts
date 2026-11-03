import { expect, test } from "@playwright/test";

import { openWorkbench } from "../support/local-access";
import { clearMcpServers, openSettingsSection } from "../support/settings";

test.describe("插件、MCP 与技能", () => {
  test.beforeAll(async ({ browser }) => {
    // 清掉上一次运行残留的 MCP 配置，空态与增删流程才可重复。
    const page = await browser.newPage();
    await openWorkbench(page);
    await clearMcpServers(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
  });

  test("插件与技能在没有安装项时如实显示空态", async ({ page }) => {
    const management = await openSettingsSection(page, "插件·MCP·技能");
    await management.getByRole("tab", { name: /插件/ }).first().click();
    await expect(
      management.getByText("尚未安装插件", { exact: true }),
    ).toBeVisible();
    await management.getByRole("tab", { name: /技能/ }).first().click();
    await expect(
      management.getByText("尚未安装技能", { exact: true }),
    ).toBeVisible();
  });

  test("MCP 服务器可在界面新增并删除", async ({ page }) => {
    const management = await openSettingsSection(page, "插件·MCP·技能");
    await management.getByRole("tab", { name: /MCP/ }).first().click();
    await expect(
      management.getByText("尚未安装 MCP 服务器", { exact: true }),
    ).toBeVisible();
    await management.getByRole("button", { name: "新建 MCP 服务器", exact: true }).click();

    await management.getByPlaceholder("my-mcp-server").fill("e2e-mcp");
    // `cat` 是真实可启动的常驻进程：不响应 MCP 握手会显示连接失败，
    // 但不会像错误的 REPL 命令那样让子进程崩掉。
    await management.getByPlaceholder("npx").fill("cat");
    const createResponse = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await management.getByRole("button", { name: "保存", exact: true }).click();
    expect((await createResponse).status()).toBe(200);

    const row = management.getByRole("button", { name: /e2e-mcp/ }).first();
    await expect(row).toBeVisible();

    await row.click();
    const deleteResponse = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await management.getByRole("button", { name: "删除", exact: true }).click();
    await management
      .getByRole("button", { name: /确认删除/ })
      .click();
    expect((await deleteResponse).status()).toBe(200);

    await expect(
      management.getByRole("button", { name: /e2e-mcp/ }),
    ).toHaveCount(0);
    await expect(
      management.getByText("尚未安装 MCP 服务器", { exact: true }),
    ).toBeVisible();
  });
});
