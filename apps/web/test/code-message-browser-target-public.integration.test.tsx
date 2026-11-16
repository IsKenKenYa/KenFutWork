// @vitest-environment node
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import { withTaskGroupPublicPage } from "./setup/code-task-groups-public.fixture.js";

const settingsButton =
  '[data-root-workspace-surface="interactive"] [data-testid="task-settings-button"]';
const composer = '[role="textbox"][contenteditable="true"]';
const choice = '[role="combobox"][aria-label="AI 任务默认浏览器"]';
const openTab = '[data-side-pane-tab-id^="browser:"][data-state="active"]';
const browserTargets = z.object({
  targetInfos: z.array(
    z.object({ type: z.string(), url: z.string(), targetId: z.string() }),
  ),
});

async function chooseBrowser(page: OriginalSessionBrowser, label: string) {
  await clickOn(page.cdp, page.target.sessionId, { selector: settingsButton });
  await clickExactText(page, "button", "浏览器控制");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(choice)})?.disabled`,
      ),
    ).toBe(false),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(choice)}).focus()`,
  );
  await pressKey(page.cdp, page.target.sessionId, "ArrowDown");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Array.from(document.querySelectorAll('[role="option"]')).map(node => node.textContent)`,
      ),
      "实际浏览器选项",
    ).toEqual(["内置浏览器", "外部浏览器"]),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.activeElement?.getAttribute('role')"),
    ).toBe("option"),
  );
  await pressKey(
    page.cdp,
    page.target.sessionId,
    label === "外部浏览器" ? "End" : "Home",
  );
  await vi.waitFor(async () =>
    expect(await page.evaluate("document.activeElement?.textContent")).toBe(
      label,
    ),
  );
  await pressKey(page.cdp, page.target.sessionId, "Enter");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(choice)})?.textContent`,
      ),
    ).toBe(label),
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="settings-back-button"]',
  });
}

async function tabsAt(page: OriginalSessionBrowser, url: string) {
  const result = browserTargets.parse(await page.cdp.send("Target.getTargets"));
  return result.targetInfos.filter(
    (target) => target.type === "page" && target.url === url,
  );
}

async function closeExternalTab(page: OriginalSessionBrowser, url: string) {
  const external = await vi.waitFor(
    async () => {
      const tabs = await tabsAt(page, url);
      expect(tabs).toHaveLength(1);
      return tabs[0];
    },
    { timeout: 5_000 },
  );
  if (!external) throw new Error("外部浏览器未打开测试地址");
  await page.cdp.send("Target.closeTarget", { targetId: external.targetId });
  await page.cdp.send("Target.activateTarget", {
    targetId: page.target.targetId,
  });
}

async function activeBrowserTab(page: OriginalSessionBrowser) {
  return page.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(openTab)})?.getAttribute('data-side-pane-tab-id') ?? null`,
  );
}

async function clickMessageLink(
  page: OriginalSessionBrowser,
  url: string,
  button: "left" | "right",
  modifiers: number,
) {
  const point = await vi.waitFor(async () => {
    const hit = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const link = Array.from(document.querySelectorAll(${JSON.stringify(`button[title=${JSON.stringify(url)}]`)}))
        .find(element => element.checkVisibility() && !element.closest('[aria-hidden="true"]'));
      if (!link) return null;
      link.scrollIntoView({ block: 'center' });
      await new Promise(requestAnimationFrame);
      const rect = link.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return link.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    expect(hit, `会话链接应可接收 ${button} 点击`).not.toBeNull();
    return hit;
  });
  if (!point) throw new Error("会话链接未显示");
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button, modifiers, clickCount: 1 },
      page.target.sessionId,
    );
  }
}

async function chooseLinkMenu(page: OriginalSessionBrowser, label: string) {
  await vi.waitFor(async () => {
    const focused = await page.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.textContent.trim() === ${JSON.stringify(label)} && node.checkVisibility());
      item?.focus();
      return item === document.activeElement;
    })()`);
    expect(focused, `实际链接菜单应包含「${label}」`).toBe(true);
  });
  await pressKey(page.cdp, page.target.sessionId, "Enter");
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原工作台使用已保存的默认浏览器打开会话链接，保留原任务与草稿",
  async () => {
    await withTaskGroupPublicPage(
      async ({ fixture, host, model, page }) => {
        const url = new URL(
          "/api/health?link=browser-target&view=full#details",
          fixture.baseUrl,
        ).href;
        const label = "打开测试服务";
        const draft = "浏览器切换期间保留的草稿";
        const link = "[data-session-id] button, [data-session-id] a";
        expect(
          (await host.command("sendText", { text: "显示测试服务链接" })).status,
        ).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.writeText(0, `[${label}](${url})`);
        model.finish(0);
        await clickOn(page.cdp, page.target.sessionId, { selector: composer });
        await typeText(page.cdp, page.target.sessionId, draft);

        await chooseBrowser(page, "外部浏览器");
        await vi.waitFor(async () => {
          expect(
            await page.evaluate(
              `Array.from(document.querySelectorAll(${JSON.stringify(link)})).some(node => node.textContent.trim() === ${JSON.stringify(label)})`,
            ),
            "实际会话链接",
          ).toBe(true);
        });
        await clickExactText(page, link, label);
        await closeExternalTab(page, url);
        expect(await activeBrowserTab(page)).toBeNull();

        await clickMessageLink(page, url, "right", 0);
        await chooseLinkMenu(page, "在工作台中打开");
        const manuallyOpened = await vi.waitFor(async () => {
          const active = await activeBrowserTab(page);
          expect(active).toMatch(/^browser:/u);
          return active;
        });
        expect(await tabsAt(page, url)).toHaveLength(0);

        await chooseBrowser(page, "内置浏览器");
        await clickExactText(page, link, label);
        const openedByPreference = await vi.waitFor(async () => {
          const active = await activeBrowserTab(page);
          expect(active).toMatch(/^browser:/u);
          expect(active).not.toBe(manuallyOpened);
          return active;
        });
        expect(await tabsAt(page, url)).toHaveLength(0);
        await clickMessageLink(page, url, "right", 0);
        await chooseLinkMenu(page, "在浏览器中打开");
        await closeExternalTab(page, url);
        const modifier = await page.evaluate<number>(
          'navigator.platform.includes("Mac") ? 4 : 2',
        );
        await clickMessageLink(page, url, "left", modifier);
        await closeExternalTab(page, url);
        expect(await activeBrowserTab(page)).toBe(openedByPreference);
        expect(
          await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(composer)});
        return { text: input?.textContent, taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') };
      })()`),
        ).toEqual({ text: draft, taskId: host.sessionId });
        expect(model.requests).toHaveLength(1);
      },
      { prepareTaskContent: false, supportsEmbeddedBrowser: true },
    );
  },
  150_000,
);
