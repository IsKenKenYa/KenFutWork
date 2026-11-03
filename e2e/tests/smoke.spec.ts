import { expect, test } from "@playwright/test";

import { openWorkbench, workbenchFrame } from "../support/local-access";

test.describe("本地免账户入口与工作台外壳", () => {
  test("ticket 兑换后 /api/instance 可用且外壳加载", async ({ page }) => {
    await openWorkbench(page);

    const instanceResponse = await page.request.get("/api/instance");
    expect(instanceResponse.status()).toBe(200);
    const instance = await instanceResponse.json();
    expect(instance.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(instance.dataDir).toContain(".scratch/e2e-data");

    const shell = workbenchFrame(page);
    await expect(
      shell.locator("main p").filter({ hasText: "Code with KenFutWork" }).first(),
    ).toBeVisible({ timeout: 90_000 });
  });

  test("Code 与 Design 切换时主区内容随之变化", async ({ page }) => {
    await openWorkbench(page);
    const shell = workbenchFrame(page);

    const modes = shell.getByRole("radiogroup", { name: "模式切换" });
    const code = modes.getByRole("radio", { name: "Code", exact: true });
    const design = modes.getByRole("radio", { name: "Design", exact: true });
    await expect(code).toBeChecked();
    await expect(
      shell.locator("main p").filter({ hasText: "Code with KenFutWork" }).first(),
    ).toBeVisible();
    await expect(
      shell.locator("main p").filter({ hasText: "Design with KenFutWork" }),
    ).toHaveCount(0);

    await design.click();
    await expect(design).toBeChecked();
    await expect(
      shell.locator("main p").filter({ hasText: "Design with KenFutWork" }).first(),
    ).toBeVisible();
    await expect(
      shell.getByRole("button", { name: "移除画布引用" }),
    ).toBeVisible();

    await code.click();
    await expect(code).toBeChecked();
    await expect(
      shell.locator("main p").filter({ hasText: "Code with KenFutWork" }).first(),
    ).toBeVisible();
    await expect(
      shell.locator("main p").filter({ hasText: "Design with KenFutWork" }),
    ).toHaveCount(0);
  });
});
