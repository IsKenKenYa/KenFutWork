import { expect, vi } from "vitest";
import { clickOn } from "../../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./code-public-browser.fixture.mjs";

export async function clickExactText(
  page: OriginalSessionBrowser,
  selector: string,
  text: string,
) {
  const target = await vi.waitFor(async () => {
    const matches = await page.evaluate<{ x: number; y: number }[]>(
      `(async () => {
        const matches = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .filter(element => element.textContent.trim() === ${JSON.stringify(text)} &&
            !element.closest('[aria-hidden="true"]') && element.checkVisibility());
        for (const element of matches) element.scrollIntoView({ block: "center" });
        await new Promise(requestAnimationFrame);
        return matches.flatMap(element => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit && element.contains(hit) ? [{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }] : [];
        });
      })()`,
    );
    expect(matches, JSON.stringify(page.pageErrors)).toHaveLength(1);
    const found = matches[0];
    if (!found) throw new Error("原组件操作入口未显示。");
    return found;
  });
  await clickOn(page.cdp, page.target.sessionId, target);
}

export async function selectAll(page: OriginalSessionBrowser) {
  const modifiers = await page.evaluate<number>(
    'navigator.platform.includes("Mac") ? 4 : 2',
  );
  for (const type of ["keyDown", "keyUp"]) {
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers,
        ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
      },
      page.target.sessionId,
    );
  }
}
