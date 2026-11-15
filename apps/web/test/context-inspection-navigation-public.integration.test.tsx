// @vitest-environment node
import { expect, it, vi } from "vitest";
import { pressKey } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  expectContentPreserved,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const opener = 'button[aria-label="上下文分析"]';
const inspector = '[role="dialog"][aria-label="上下文分析"]';

async function narrowViewport(page: OriginalSessionBrowser) {
  await page.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 320, height: 448, deviceScaleFactor: 1, mobile: false },
    page.target.sessionId,
  );
  await vi.waitFor(async () => {
    expect(await page.evaluate("innerWidth")).toBe(320);
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(opener)})?.checkVisibility()`,
      ),
    ).toBe(true);
  });
}

async function focusInspectorEntry(page: OriginalSessionBrowser) {
  await page.evaluate(
    `document.querySelector(${JSON.stringify(opener)}).focus()`,
  );
  const { cdp, target } = page;
  // 走真实键盘遍历，避免脚本聚焦掩盖键盘可见状态。
  await pressKey(cdp, target.sessionId, "Tab");
  await pressShiftTab(page);
  return page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(opener)});
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      focused: document.activeElement === button,
      visible: rect.left >= 0 && rect.right <= innerWidth &&
        rect.top >= 0 && rect.bottom <= innerHeight,
      outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
    };
  })()`);
}

async function pressShiftTab({ cdp, target }: OriginalSessionBrowser) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
      target.sessionId,
    );
}

async function openWithKeyboard(page: OriginalSessionBrowser) {
  const { cdp, target } = page;
  // CDP 的 Enter 需显式附带字符，才能触发原生按钮的按键激活。
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", ...key, text: "\r" },
    target.sessionId,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...key },
    target.sessionId,
  );
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`(() => {
        const dialog = document.querySelector(${JSON.stringify(inspector)});
        if (!dialog) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          bounded: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          closeFocused: dialog.contains(document.activeElement) &&
            document.activeElement.textContent.trim() === "关闭",
          currentRequest: Boolean(dialog.querySelector('nav[aria-label="模型请求"] [aria-current="true"]')),
          contentInert: Boolean(document.querySelector('#conversation-column').closest('[inert]')),
          previewOpen: Boolean(document.querySelector('[data-slot="hover-card-content"]')),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      bounded: true,
      closeFocused: true,
      currentRequest: true,
      contentInert: true,
      previewOpen: false,
    });
  });
}

async function expectFocusRestored(page: OriginalSessionBrowser) {
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`({
        open: Boolean(document.querySelector(${JSON.stringify(inspector)})),
        restored: document.activeElement?.matches(${JSON.stringify(opener)}),
      })`),
    ).toEqual({ open: false, restored: true });
  });
}

async function expectDialogTabFocus(page: OriginalSessionBrowser) {
  await pressShiftTab(page);
  expect(
    await page.evaluate(`(() => {
      const focused = document.activeElement;
      const dialog = document.querySelector(${JSON.stringify(inspector)});
      const style = getComputedStyle(focused);
      return {
        inside: dialog.contains(focused),
        label: focused.textContent.trim(),
        outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    })()`),
  ).toEqual({ inside: true, label: "刷新", outlined: true });
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "窄窗通过键盘打开上下文分析，返回原 Task 草稿和入口",
  async () => {
    await withTaskGroupPublicPage(
      async (context) => {
        const { page } = context;
        const { cdp, target } = page;
        await narrowViewport(page);
        const entry = await focusInspectorEntry(page);
        expect(entry).toMatchObject({ focused: true, visible: true });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'Boolean(document.querySelector(\'[data-slot="hover-card-content"][data-state="open"]\'))',
            ),
          ).toBe(true),
        );
        await openWithKeyboard(page);
        await pressKey(cdp, target.sessionId, "Escape");
        await expectFocusRestored(page);
        expect(entry).toHaveProperty("outlined", true);
        await openWithKeyboard(page);
        await expectDialogTabFocus(page);
        await pressKey(cdp, target.sessionId, "Escape");
        await expectFocusRestored(page);
        await cdp.send(
          "Emulation.clearDeviceMetricsOverride",
          {},
          target.sessionId,
        );
        await expectContentPreserved(context);
        expect(context.model.requests).toHaveLength(
          context.modelRequestCountBefore,
        );
      },
      { seedTaskHistory: true },
    );
  },
  180_000,
);
