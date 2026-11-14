// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import type { PublicFixture } from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const scratchRoot = fileURLToPath(
  new URL("../../../.scratch/", import.meta.url),
);

async function clickOriginalDownloadMenu(page: OriginalSessionBrowser) {
  const imageSelector = '[data-testid="preview-pane"] [data-image-preview] img';
  await vi.waitFor(
    async () => {
      const observation = await page.evaluate<{
        image: { loaded: boolean; width: number; height: number } | null;
        diagnostic: Record<string, unknown>;
      }>(`(() => {
        const pane = document.querySelector('[data-testid="preview-pane"]');
        const image = document.querySelector(${JSON.stringify(imageSelector)});
        const images = Array.from(pane?.querySelectorAll("img") ?? []).slice(0, 5);
        const markers = Array.from(pane?.querySelectorAll(
          '[data-testid], [data-preview-pane-heavy-content-deferred], [data-language]'
        ) ?? []).slice(0, 10);
        const selectedViews = Array.from(pane?.querySelectorAll(
          '[role="tab"][aria-selected="true"], [role="tab"][data-state="active"], [aria-pressed="true"]'
        ) ?? []).slice(0, 5);
        return {
          image: image ? {
            loaded: image.complete,
            width: image.naturalWidth,
            height: image.naturalHeight,
          } : null,
          diagnostic: {
            surfaceState: document.documentElement.getAttribute("data-code-public-session-state"),
            paneExists: Boolean(pane),
            selectorMatches: document.querySelectorAll(${JSON.stringify(imageSelector)}).length,
            readableText: (pane?.innerText ?? "").replace(/data:[^\\s"'<>]+/gu, "[媒体来源]").slice(0, 800),
            markers: markers.map((element) => ({
              tag: element.tagName,
              testId: element.getAttribute("data-testid"),
              language: element.getAttribute("data-language"),
              deferred: element.getAttribute("data-preview-pane-heavy-content-deferred"),
            })),
            selectedViews: selectedViews.map((element) => ({
              role: element.getAttribute("role"),
              text: element.textContent?.trim().slice(0, 80),
            })),
            images: images.map((item) => ({
              alt: item.alt.slice(0, 120),
              loaded: item.complete,
              width: item.naturalWidth,
              height: item.naturalHeight,
              sourceType: /^(?:data:([^;,]+)|([^:]+):)/u.exec(item.currentSrc || item.src)?.slice(1),
              matchesSelector: item.matches(${JSON.stringify(imageSelector)}),
            })),
          },
        };
      })()`);
      expect(
        observation.image,
        JSON.stringify({
          ...observation.diagnostic,
          pageErrors: page.pageErrors,
        }),
      ).toEqual({
        loaded: true,
        width: 96,
        height: 48,
      });
    },
    { timeout: 60_000 },
  );
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const image = document.querySelector(${JSON.stringify(imageSelector)});
    const bounds = image.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  }
  const selector = '[data-image-preview-download][role="menuitem"]';
  await vi.waitFor(async () => {
    const action = await page.evaluate(`(() => {
      const item = document.querySelector(${JSON.stringify(selector)});
      return {
        label: item?.textContent.trim(),
        enabled: Boolean(item && !item.hasAttribute("data-disabled")),
      };
    })()`);
    expect(action, JSON.stringify(page.pageErrors)).toEqual({
      label: "下载图片",
      enabled: true,
    });
  });
  await clickOn(page.cdp, page.target.sessionId, { selector });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原图片预览下载 integration",
  () => {
    it("原 PreviewPane 文件来源的 SVG 下载保留文件名及 BOM、CRLF 和 Unicode 原字节", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture & { origin: string }>;
      }> = import(fixturePath);
      const [http, sessions] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      let downloadDirectory: string | undefined;
      const releaseObservations: (() => void)[] = [];
      const failures: unknown[] = [];
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
        });
        const filename = "原图-编码校验.svg";
        const original = Buffer.from(
          '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48">\r\n' +
            "<title>完整原图🙂</title>\r\n" +
            '<rect x="0" y="0" width="96" height="48" fill="#2367ab"/>\r\n' +
            "</svg>\r\n",
          "utf8",
        );
        const sourcePath = join(host.workspacePath, filename);
        await writeFile(sourcePath, original);
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
          initialPreview: {
            type: "file",
            path: sourcePath,
            title: filename,
            mediaType: "image/svg+xml",
          },
        });
        // 浏览器夹具已确认 .scratch 被忽略；下载目录只属于本测试。
        downloadDirectory = await mkdtemp(
          join(scratchRoot, "code-image-download-"),
        );
        const page = browser;
        let started: { guid: string; suggestedFilename: string } | undefined;
        const progress = new Map<string, string>();
        releaseObservations.push(
          page.cdp.on("Browser.downloadWillBegin", (params) => {
            if (
              typeof params.guid === "string" &&
              typeof params.suggestedFilename === "string"
            )
              started = {
                guid: params.guid,
                suggestedFilename: params.suggestedFilename,
              };
          }),
          page.cdp.on("Browser.downloadProgress", (params) => {
            if (
              typeof params.guid === "string" &&
              typeof params.state === "string"
            )
              progress.set(params.guid, params.state);
          }),
        );
        await page.cdp.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: downloadDirectory,
          eventsEnabled: true,
        });

        await clickOriginalDownloadMenu(page);

        await vi.waitFor(
          () => {
            expect(started?.suggestedFilename).toBe(filename);
            expect(started && progress.get(started.guid)).toBe("completed");
          },
          { timeout: 30_000 },
        );
        expect(await readdir(downloadDirectory)).toEqual([filename]);
        expect(await readFile(join(downloadDirectory, filename))).toStrictEqual(
          original,
        );
      } catch (error) {
        failures.push(error);
      } finally {
        for (const release of releaseObservations) release();
        for (const close of [
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () =>
            downloadDirectory &&
            rm(downloadDirectory, { recursive: true, force: true }),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原图片下载验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
