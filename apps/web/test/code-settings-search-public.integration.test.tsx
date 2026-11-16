// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  setViewportOverride,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import { SETTINGS_SEARCH_ITEMS } from "../src/components/workbench/zcode/settings-search/settingsSearchIndex.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import { selectAll } from "./setup/code-public-browser-actions.js";
import type { PublicFixture } from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const composerSelector = '[role="textbox"][contenteditable="true"]';
const draft = "设置搜索期间保留的草稿";

async function press(page: OriginalSessionBrowser, key: "Escape" | "Enter") {
  for (const type of ["keyDown", "keyUp"]) {
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: key === "Escape" ? 27 : 13,
      },
      page.target.sessionId,
    );
  }
}

async function openSearch(page: OriginalSessionBrowser) {
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="settings-search-open"]',
  });
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(
        'document.activeElement?.getAttribute("data-testid")',
      ),
    ).toBe("settings-search-input");
  });
  await page.evaluate(
    `Promise.all(document.querySelector('[data-testid="settings-search-dialog"]').getAnimations({ subtree: true }).map(animation => animation.finished))`,
  );
}

async function query(page: OriginalSessionBrowser, text: string) {
  await selectAll(page);
  await typeText(page.cdp, page.target.sessionId, text);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-search-input]")?.value',
      ),
    ).toBe(text),
  );
}

async function expectTarget(page: OriginalSessionBrowser, id: string) {
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(`[data-settings-search-target="${id}"]`)});
      const rect = node?.getBoundingClientRect();
      return {
        id: ${JSON.stringify(id)},
        open: Boolean(document.querySelector('[data-testid="settings-search-dialog"]')),
        focused: node === document.activeElement,
        active: document.activeElement?.outerHTML.slice(0, 500),
        bounds: rect ? [rect.top, rect.bottom, innerHeight] : null,
        visible: !!rect && rect.top >= 0 && rect.bottom <= innerHeight,
      };
    })()`),
    ).toEqual(
      expect.objectContaining({ open: false, focused: true, visible: true }),
    );
  });
}

async function expectSelectedSize(page: OriginalSessionBrowser) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-settings-search-result][aria-selected=true]")?.getAttribute("data-settings-search-result")',
      ),
    ).toBe("settings.uiFontSize"),
  );
}

async function checkSearchDismissal(page: OriginalSessionBrowser) {
  await query(page, "zzzz-not-a-setting");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'Boolean(document.querySelector("[data-testid=settings-search-empty]"))',
      ),
    ).toBe(true),
  );
  await page.evaluate(
    `document.querySelector('[data-testid="settings-search-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }))`,
  );
  expect(
    await page.evaluate(
      'document.querySelector("[data-testid=settings-search-input]")?.value',
    ),
  ).toBe("zzzz-not-a-setting");
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="settings-search-clear"]',
  });
  await query(page, "zzzz-not-a-setting");
  await press(page, "Escape");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-search-input]")?.value',
      ),
    ).toBe(""),
  );
  await press(page, "Escape");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.activeElement?.getAttribute("data-testid")',
      ),
    ).toBe("settings-search-open"),
  );
}

async function exerciseSearch(page: OriginalSessionBrowser) {
  await openSearch(page);
  expect(
    await page.evaluate(
      'document.querySelectorAll("[data-settings-search-result=commands], [data-settings-search-result=hooks], [data-settings-search-result=automations], [data-settings-search-result=workspaceFileSearch]").length',
    ),
  ).toBe(0);
  for (const text of ["界面字号", "UI font size"]) {
    await query(page, text);
    await expectSelectedSize(page);
    await press(page, "Enter");
    await expectTarget(page, "settings.uiFontSize");
    await openSearch(page);
  }
  await checkSearchDismissal(page);
  for (const item of SETTINGS_SEARCH_ITEMS) {
    await openSearch(page);
    await clickOn(page.cdp, page.target.sessionId, {
      selector: `[data-settings-search-result="${item.id}"]`,
    });
    await expectTarget(page, item.id);
  }
  for (const size of [
    { width: 390, height: 720 },
    { width: 320, height: 448 },
  ]) {
    await setViewportOverride(page.cdp, page.target.sessionId, size);
    await openSearch(page);
    expect(
      await page.evaluate(`(() => {
      const box = document.querySelector('[data-testid="settings-search-dialog"]').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
    })()`),
    ).toBe(true);
    await query(page, "jiemianzihao");
    await expectSelectedSize(page);
    await press(page, "Enter");
    await expectTarget(page, "settings.uiFontSize");
    expect(
      await page.evaluate(`(() => {
        const row = document.querySelector('[data-settings-search-target="settings.uiFontSize"]');
        const labelNode = row.querySelector('.font-medium');
        const label = labelNode.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(labelNode);
        const labelReadable = [...text.getClientRects()].every(rect => rect.left >= label.left - 1 && rect.right <= label.right + 1);
        const field = row.querySelector('input').getBoundingClientRect();
        return { labelReadable, fieldInside: field.left >= 0 && field.right <= innerWidth, labelWidth: label.width, fieldRight: field.right, width: innerWidth };
      })()`),
    ).toEqual(
      expect.objectContaining({ labelReadable: true, fieldInside: true }),
    );
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原设置搜索公开导航",
  () => {
    it("搜索可见设置并在关闭弹层后定位实际设置行", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture & { origin: string }>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let page: OriginalSessionBrowser | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        page = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
          workspaceShell: true,
        });
        await clickOn(page.cdp, page.target.sessionId, {
          selector: composerSelector,
        });
        await typeText(page.cdp, page.target.sessionId, draft);
        const requestCount = model.requests.length;
        await clickOn(page.cdp, page.target.sessionId, {
          selector:
            '[data-root-workspace-surface="interactive"] [data-testid="task-settings-button"]',
        });
        const browser = page;
        await vi.waitFor(async () => {
          expect(
            await browser.evaluate(
              'Boolean(document.querySelector("[data-testid=settings-search-open]"))',
            ),
          ).toBe(true);
        });
        await exerciseSearch(browser);
        await clickOn(browser.cdp, browser.target.sessionId, {
          selector: '[data-testid="settings-back-button"]',
        });
        await vi.waitFor(async () =>
          expect(
            await browser.evaluate(
              `document.querySelector(${JSON.stringify(composerSelector)})?.textContent`,
            ),
          ).toBe(draft),
        );
        expect(model.requests).toHaveLength(requestCount);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => page?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "设置搜索验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
