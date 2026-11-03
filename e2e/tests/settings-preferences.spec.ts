import { expect, test } from "@playwright/test";

import { openWorkbench } from "../support/local-access";
import {
  managementFrame,
  openSettingsSection,
  settingsRow,
} from "../support/settings";

test.describe("偏好保存往返与非法输入", () => {
  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
  });

  test("上下文自动压缩开关保存后刷新仍生效", async ({ page }) => {
    let management = await openSettingsSection(page, "常规");
    const autoCompact = settingsRow(management, "上下文自动压缩").getByRole("switch");
    await expect(autoCompact).toBeChecked();

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/instance/settings") &&
          response.request().method() === "PATCH",
      ),
      autoCompact.click(),
    ]);
    await expect(autoCompact).not.toBeChecked();

    await page.reload();
    management = await openSettingsSection(page, "常规");
    await expect(
      settingsRow(management, "上下文自动压缩").getByRole("switch"),
    ).not.toBeChecked();

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/instance/settings") &&
          response.request().method() === "PATCH",
      ),
      settingsRow(management, "上下文自动压缩").getByRole("switch").click(),
    ]);
    await expect(
      settingsRow(management, "上下文自动压缩").getByRole("switch"),
    ).toBeChecked();
  });

  test("自动归档开关与天数保存后刷新仍生效", async ({ page }) => {
    let management = await openSettingsSection(page, "常规");
    const archiveSwitch = settingsRow(management, "自动归档旧任务").getByRole("switch");
    const days = settingsRow(management, "归档保留时长").getByRole("combobox");
    await expect(archiveSwitch).not.toBeChecked();
    await expect(days).toBeDisabled();

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/code-ui/rpc"),
      ),
      archiveSwitch.click(),
    ]);
    await expect(archiveSwitch).toBeChecked();
    await expect(days).toBeEnabled();

    await days.click();
    await management.getByRole("option", { name: "14 天后归档" }).click();
    await expect(days).toContainText("14 天后归档");

    await page.reload();
    management = await openSettingsSection(page, "常规");
    await expect(
      settingsRow(management, "自动归档旧任务").getByRole("switch"),
    ).toBeChecked();
    const persistedDays = settingsRow(management, "归档保留时长").getByRole("combobox");
    await expect(persistedDays).toContainText("14 天后归档");

    await persistedDays.click();
    await management.getByRole("option", { name: "7 天后归档" }).click();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/code-ui/rpc"),
      ),
      settingsRow(management, "自动归档旧任务").getByRole("switch").click(),
    ]);
    await expect(
      settingsRow(management, "自动归档旧任务").getByRole("switch"),
    ).not.toBeChecked();
    await expect(settingsRow(management, "归档保留时长").getByRole("combobox")).toContainText(
      "7 天后归档",
    );
  });

  test("HTTP 代理非法地址被拒绝且不落库", async ({ page }) => {
    const management = await openSettingsSection(page, "常规");
    const proxyInput = management.locator(
      'input[placeholder^="留空则内置浏览器跟随系统代理"]',
    );
    const row = settingsRow(
      management,
      "HTTP 代理",
    );
    const save = row.getByRole("button", { name: "保存", exact: true });

    await proxyInput.fill("not-a-url");
    const rejected = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await save.click();
    expect((await rejected).status()).toBe(409);
    await expect(proxyInput).toHaveValue("not-a-url");

    test.info().annotations.push({
      type: "known-gap",
      description: "代理保存失败只记录 telemetry，界面没有可读原因。",
    });
    await expect(
      managementFrame(page).getByText("HTTP 代理地址不是合法 URL。"),
    ).toHaveCount(0);

    await page.reload();
    const reloaded = await openSettingsSection(page, "常规");
    await expect(
      reloaded.locator('input[placeholder^="留空则内置浏览器跟随系统代理"]'),
    ).toHaveValue("");
  });

  test("合法 HTTP 代理保存后刷新仍生效，清空后恢复", async ({ page }) => {
    let management = await openSettingsSection(page, "常规");
    const proxyInput = management.locator(
      'input[placeholder^="留空则内置浏览器跟随系统代理"]',
    );
    const save = settingsRow(management, "HTTP 代理").getByRole("button", {
      name: "保存",
      exact: true,
    });

    await proxyInput.fill("http://127.0.0.1:7890");
    const saved = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await save.click();
    expect((await saved).status()).toBe(200);

    await page.reload();
    management = await openSettingsSection(page, "常规");
    await expect(
      management.locator('input[placeholder^="留空则内置浏览器跟随系统代理"]'),
    ).toHaveValue("http://127.0.0.1:7890");

    const inputAfterReload = management.locator(
      'input[placeholder^="留空则内置浏览器跟随系统代理"]',
    );
    await inputAfterReload.fill("");
    const cleared = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await settingsRow(management, "HTTP 代理")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await cleared).status()).toBe(200);
  });

  test("自定义 CA 证书相对路径被拒绝且不落库", async ({ page }) => {
    const management = await openSettingsSection(page, "常规");
    const caInput = management.locator(
      'input[placeholder^="例如 /Users/name/certs/root-ca.pem"]',
    );
    const save = settingsRow(management, "自定义证书").getByRole("button", {
      name: "保存",
      exact: true,
    });

    await caInput.fill("certs/root-ca.pem");
    const rejected = page.waitForResponse((response) =>
      response.url().includes("/api/code-ui/rpc"),
    );
    await save.click();
    expect([400, 404, 409]).toContain((await rejected).status());
    await expect(caInput).toHaveValue("certs/root-ca.pem");

    test.info().annotations.push({
      type: "known-gap",
      description: "证书路径保存失败只记录 telemetry，界面没有可读原因。",
    });

    await page.reload();
    const reloaded = await openSettingsSection(page, "常规");
    await expect(
      reloaded.locator('input[placeholder^="例如 /Users/name/certs/root-ca.pem"]'),
    ).toHaveValue("");
  });
});
