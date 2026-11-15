// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  pressKey,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  expectContentPreserved,
  readScope,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

async function conversationRatio(page: OriginalSessionBrowser) {
  return page.evaluate<number | null>(`(() => {
    const conversation = document.getElementById('conversation-column');
    const content = document.getElementById('browser');
    if (!conversation || !content) return null;
    const left = conversation.getBoundingClientRect().width;
    const right = content.getBoundingClientRect().width;
    return left > 0 && right > 0 ? left / (left + right) : null;
  })()`);
}

async function setViewportWidth(page: OriginalSessionBrowser, width: number) {
  await page.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height: 800, deviceScaleFactor: 1, mobile: false },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(await page.evaluate("window.innerWidth")).toBe(width),
  );
}

function getWorkspaceBounds(page: OriginalSessionBrowser) {
  return page.evaluate<{
    viewport: number;
    sidebar: number;
    contentRight: number;
    inputRight: number;
    draft: string;
  }>(`(() => {
    const input = document.querySelector('[role="textbox"][contenteditable="true"]');
    return {
      viewport: window.innerWidth,
      sidebar: document.getElementById('sidebar').getBoundingClientRect().width,
      contentRight: document.getElementById('content').getBoundingClientRect().right,
      inputRight: input?.getBoundingClientRect().right,
      draft: input?.textContent,
    };
  })()`);
}

function readSavedSplit(page: OriginalSessionBrowser) {
  return page.evaluate<string | null>(`Object.entries(localStorage).find(
    ([key]) => key.startsWith('react-resizable-panels:workspace-body-layout-v2:')
  )?.[1] ?? null`);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原工作台会话宽度与真实文件内容 integration",
  () => {
    it("窄窗仍可访问导航、会话和文件，恢复宽窗口保留原分栏与任务", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const desktopWidth = 1440;
          await setViewportWidth(context.page, desktopWidth);
          await vi.waitFor(async () =>
            expect(
              await conversationRatio(context.page),
              JSON.stringify(context.page.pageErrors),
            ).toBeCloseTo(0.52, 2),
          );
          expect(
            await context.page.evaluate(`(() => {
          const input = document.querySelector('[role="textbox"][contenteditable="true"]');
          return { same: input === window.__taskGroupPublicBefore.input, draft: input?.textContent };
        })()`),
          ).toEqual({ same: true, draft: context.draft });
          const { cdp, target } = context.page;
          await context.page.evaluate(
            `document.querySelector('[data-workspace-side-pane-resize-handle]').focus()`,
          );
          for (let step = 0; step < 5; step++) {
            await pressKey(cdp, target.sessionId, "ArrowRight");
          }
          await vi.waitFor(async () =>
            expect(await conversationRatio(context.page)).toBeGreaterThan(0.55),
          );
          const desktopRatio = await conversationRatio(context.page);
          if (desktopRatio === null) throw new Error("未读取到桌面分栏比例");
          await vi.waitFor(async () =>
            expect(await readSavedSplit(context.page)).toContain("browser"),
          );
          const savedSplit = await readSavedSplit(context.page);
          for (const width of [390, 320]) {
            await setViewportWidth(context.page, width);
            await vi.waitFor(async () => {
              const bounds = await getWorkspaceBounds(context.page);
              expect(bounds, JSON.stringify(bounds)).toMatchObject({
                viewport: width,
                sidebar: 48,
                draft: context.draft,
              });
              expect(bounds.contentRight).toBeLessThanOrEqual(width);
              expect(bounds.inputRight).toBeLessThanOrEqual(width);
            });
          }
          const expand = '[aria-controls="sidebar"][aria-expanded="false"]';
          await clickOn(cdp, target.sessionId, { selector: expand });
          await vi.waitFor(async () => {
            expect(
              await context.page.evaluate(`({
              navigation: document.getElementById('sidebar').getBoundingClientRect().width,
              focused: document.activeElement?.getAttribute('aria-expanded'),
              contentInert: document.getElementById('content').inert,
            })`),
            ).toEqual({ navigation: 320, focused: "true", contentInert: true });
          });
          await pressKey(cdp, target.sessionId, "Escape");
          await vi.waitFor(async () => {
            expect(
              await context.page.evaluate(
                `document.activeElement?.matches(${JSON.stringify(expand)})`,
              ),
            ).toBe(true);
          });
          await clickOn(cdp, target.sessionId, {
            selector: '#conversation-column button[aria-label="展开侧边面板"]',
          });
          await vi.waitFor(async () => {
            expect(
              await context.page.evaluate(`(() => {
              const browser = document.getElementById('browser');
              const preview = browser.querySelector('[data-testid="preview-pane"]');
              return {
                visible: preview?.checkVisibility({visibilityProperty: true}),
                right: browser.getBoundingClientRect().right,
                focused: document.activeElement?.getAttribute('aria-label'),
              };
            })()`),
            ).toEqual({ visible: true, right: 320, focused: "收起侧边面板" });
          });
          await clickOn(cdp, target.sessionId, {
            selector: '#browser button[aria-label="收起侧边面板"]',
          });
          await vi.waitFor(async () => {
            expect(
              await context.page.evaluate(`({
                visible: document.querySelector('#conversation-column [contenteditable="true"]')?.checkVisibility({visibilityProperty: true}),
                focused: document.activeElement?.getAttribute('aria-label'),
              })`),
            ).toEqual({ visible: true, focused: "展开侧边面板" });
          });
          expect(await readSavedSplit(context.page)).toBe(savedSplit);
          await setViewportWidth(context.page, desktopWidth);
          await vi.waitFor(async () =>
            expect(await conversationRatio(context.page)).toBeCloseTo(
              desktopRatio,
              2,
            ),
          );
          await expectContentPreserved(context);
          expect(await readSavedSplit(context.page)).toBe(savedSplit);
          expect(await readScope(context.host)).toEqual(context.scopeBefore);
          expect(context.model.requests).toHaveLength(
            context.modelRequestCountBefore,
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root生产构建、实际布局、独占Chrome、真实HTTP/SSE及临时PostgreSQL。
  },
);
