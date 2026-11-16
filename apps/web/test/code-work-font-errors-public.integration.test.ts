// @vitest-environment node
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import { withTaskGroupPublicPage } from "./setup/code-task-groups-public.fixture.js";

const work = '[data-workspace-embedded-surface="work"]:not([hidden])';
const font = fileURLToPath(
  new URL(
    "../../../skills/canvas-design/canvas-fonts/InstrumentSans-Regular.ttf",
    import.meta.url,
  ),
);
const title = "Instrument Sans";
const options = { enableWork: true, prepareTaskContent: false };

async function openEngine(page: OriginalSessionBrowser) {
  await clickExactText(page, '[role="radio"]', "Work");
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="work-engine-sidebar-open"]',
  });
}

function readError(page: OriginalSessionBrowser) {
  return page.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(`${work} [role="alert"]`)})?.textContent.trim() ?? null`,
  );
}

function deleteFontFamily(page: OriginalSessionBrowser) {
  return clickExactText(page, `${work} button`, "删除");
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "字体目录无法读取时说明原因并可原位重试",
  async () => {
    await withTaskGroupPublicPage(async ({ fixture, page }) => {
      const fonts = join(fixture.directory, "work", "fonts");
      await mkdir(dirname(fonts), { recursive: true });
      await writeFile(fonts, "字体目录无法读取");
      await openEngine(page);
      await vi.waitFor(async () =>
        expect(await readError(page)).toBe("无法读取字体 请检查字体目录后重试"),
      );
      expect(
        await page.evaluate(
          `document.querySelector(${JSON.stringify(work)}).textContent.includes('暂无字体')`,
        ),
      ).toBe(false);
      await rm(fonts);
      await mkdir(fonts);
      await copyFile(font, join(fonts, "instrument.ttf"));
      await clickExactText(page, `${work} button`, "刷新字体");
      await vi.waitFor(async () => {
        expect(await readError(page)).toBeNull();
        expect(
          await page.evaluate(
            `document.querySelector(${JSON.stringify(work)}).textContent`,
          ),
        ).toContain(title);
      });
    }, options);
  },
  180_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "同一家族部分删除失败时说明原因并停止删除后续文件",
  async () => {
    await withTaskGroupPublicPage(async ({ fixture, page }) => {
      const fonts = join(fixture.directory, "work", "fonts");
      const first = join(fonts, "a.ttf");
      const blocked = join(fonts, "b.ttf");
      const last = join(fonts, "c.ttf");
      await mkdir(fonts, { recursive: true });
      await Promise.all(
        [first, blocked, last].map((path) => copyFile(font, path)),
      );
      await openEngine(page);
      await vi.waitFor(async () =>
        expect(
          await page.evaluate(
            `document.querySelector(${JSON.stringify(work)})?.textContent`,
          ),
        ).toContain(title),
      );
      await rename(blocked, `${blocked}.backup`);
      await mkdir(blocked);
      await deleteFontFamily(page);
      await vi.waitFor(async () =>
        expect(await readError(page)).toBe("无法删除字体 请检查字体目录后重试"),
      );
      await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(last)).isFile()).toBe(true);

      await rm(blocked, { recursive: true });
      await rename(`${blocked}.backup`, blocked);
      await clickExactText(page, `${work} button`, "刷新字体");
      await vi.waitFor(async () => expect(await readError(page)).toBeNull());
      await deleteFontFamily(page);
      await vi.waitFor(async () => {
        expect(await readError(page)).toBeNull();
        expect(
          await page.evaluate(
            `document.querySelector(${JSON.stringify(work)}).textContent`,
          ),
        ).not.toContain(title);
      });
      for (const path of [blocked, last])
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }, options);
  },
  180_000,
);
