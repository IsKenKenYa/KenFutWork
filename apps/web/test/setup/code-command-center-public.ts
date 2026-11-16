import { expect, vi } from "vitest";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./code-public-browser.fixture.mjs";

export const commandSearchInput =
  '[role="combobox"][placeholder="搜索操作、任务或文件"]';

export async function openCommandCenter(page: OriginalSessionBrowser) {
  const launcher = '[data-testid="sidebar-search-open"]';
  const waitVisible = (selector: string) =>
    vi.waitFor(async () =>
      expect(
        await page.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`,
        ),
      ).toBe(true),
    );
  await waitVisible(launcher);
  await clickOn(page.cdp, page.target.sessionId, { selector: launcher });
  await waitVisible(commandSearchInput);
}

export async function enterCommandQuery(
  page: OriginalSessionBrowser,
  query: string,
) {
  expect(
    await page.evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(commandSearchInput)});
      field.focus();
      field.select();
      return document.activeElement === field;
    })()`),
  ).toBe(true);
  await typeText(page.cdp, page.target.sessionId, query);
}

export async function activateCommandButton(
  page: OriginalSessionBrowser,
  label: string,
) {
  const { cdp, target } = page;
  for (let index = 0; index < 8; index += 1) {
    await pressKey(cdp, target.sessionId, "Tab");
    if (
      await page.evaluate<boolean>(
        `document.activeElement?.textContent.trim() === ${JSON.stringify(label)}`,
      )
    ) {
      await pressKey(cdp, target.sessionId, "Enter");
      return;
    }
  }
  throw new Error(`键盘焦点未到达「${label}」按钮`);
}
