import { expect, test } from "@playwright/test";

import { openWorkbench } from "../support/local-access";
import { openSettingsSection } from "../support/settings";

const commandLabel = "切换深色/浅色主题";
const recordButton = `重新录制「${commandLabel}」快捷键`;

test.describe("键盘快捷键录制", () => {
  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
  });

  test("非法组合与占用组合被拒绝，合法组合保存并保持", async ({ page }) => {
    let management = await openSettingsSection(page, "键盘快捷键");
    await management.getByRole("button", { name: recordButton }).first().click();

    await page.keyboard.press("a");
    await expect(
      management.getByText("至少需要一个修饰键（Ctrl / Cmd / Alt）"),
    ).toBeVisible();

    await page.keyboard.press("Meta+k");
    await expect(
      management.getByText("已被「打开命令中心」占用"),
    ).toBeVisible();

    const saved = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await page.keyboard.press("Meta+Shift+y");
    expect((await saved).status()).toBe(200);

    await expect(management.getByText("Y", { exact: true }).first()).toBeVisible();

    await page.reload();
    management = await openSettingsSection(page, "键盘快捷键");
    await expect(
      management.getByText("Y", { exact: true }).first(),
    ).toBeVisible();

    await management.getByRole("button", { name: recordButton }).first().click();
    await page.keyboard.press("Backspace");
    await expect(
      management.getByText("至少需要一个修饰键（Ctrl / Cmd / Alt）"),
    ).toHaveCount(0);
    await expect(management.getByText("L", { exact: true }).first()).toBeVisible();
  });
});
