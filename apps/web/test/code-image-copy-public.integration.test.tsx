// @vitest-environment node
import { createRequire } from "node:module";
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
const requireServer = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const sharp = requireServer("sharp");
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function copyLoadedPreviewImage(page: OriginalSessionBrowser) {
  const imageSelector = '[data-testid="preview-pane"] [data-image-preview] img';
  await vi.waitFor(
    async () => {
      const observed = await page.evaluate<{
        image: {
          loaded: boolean;
          width: number;
          height: number;
          displayWidth: string;
          displayHeight: string;
        } | null;
        paneText: string;
      }>(`(() => {
        const pane = document.querySelector('[data-testid="preview-pane"]');
        const image = document.querySelector(${JSON.stringify(imageSelector)});
        return {
          image: image ? {
            loaded: image.complete,
            width: image.naturalWidth,
            height: image.naturalHeight,
            displayWidth: image.style.width,
            displayHeight: image.style.height,
          } : null,
          paneText: (pane?.innerText ?? "").replace(/data:[^\\s"'<>]+/gu, "[媒体来源]").slice(0, 600),
        };
      })()`);
      expect(
        observed.image,
        JSON.stringify({
          paneText: observed.paneText,
          pageErrors: page.pageErrors,
        }),
      ).toEqual({
        loaded: true,
        width: 2,
        height: 2,
        displayWidth: "1px",
        displayHeight: "1px",
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
  const selector = '[data-image-preview-copy][role="menuitem"]';
  await vi.waitFor(async () => {
    const action = await page.evaluate(`(() => {
      const item = document.querySelector(${JSON.stringify(selector)});
      return {
        label: item?.textContent.trim(),
        enabled: Boolean(item && !item.hasAttribute("data-disabled")),
      };
    })()`);
    expect(action, JSON.stringify(page.pageErrors)).toEqual({
      label: "复制图片",
      enabled: true,
    });
  });
  await clickOn(page.cdp, page.target.sessionId, { selector });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原图片预览的自有 headless Chrome 剪贴板 integration",
  () => {
    it("拒绝剪贴板后可重新复制图片并保留 @2x PNG 的自然尺寸、颜色与透明像素", async () => {
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
      const failures: unknown[] = [];
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
        });
        const filename = "透明颜色@2x.png";
        const sourcePath = join(host.workspacePath, filename);
        // 顺序为红色、绿色、蓝色和全透明像素。
        const expectedRgba = Buffer.from([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
        ]);
        await sharp(expectedRgba, {
          raw: { width: 2, height: 2, channels: 4 },
        })
          .png()
          .toFile(sourcePath);
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
            path: sourcePath,
            title: filename,
            mediaType: "image/png",
          },
        });
        const page = browser;
        const origin = await page.evaluate<string>("window.location.origin");
        await page.cdp.send("Browser.setPermission", {
          origin,
          permission: { name: "clipboard-write" },
          setting: "denied",
        });
        await page.cdp.send("Page.bringToFront", {}, page.target.sessionId);

        await copyLoadedPreviewImage(page);
        await vi.waitFor(async () => {
          expect(
            await page.evaluate<string>(
              'document.getElementById("zcode-toast-host")?.innerText.slice(0, 600) ?? ""',
            ),
          ).toContain("复制图片失败");
        });
        await page.cdp.send("Browser.grantPermissions", {
          origin,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        await copyLoadedPreviewImage(page);

        await vi.waitFor(
          async () => {
            const toastText = await page.evaluate<string>(
              'document.getElementById("zcode-toast-host")?.innerText.slice(0, 600) ?? ""',
            );
            expect(toastText, JSON.stringify(page.pageErrors)).toContain(
              "图片已复制",
            );
          },
          { timeout: 15_000 },
        );
        // 仅在原操作报告成功后读取本次写入的 PNG，不读取复制前的内容。
        const clipboard = await page.evaluate<{
          mime: string;
          bytes: number[];
        }>(`(async () => {
          const items = await navigator.clipboard.read();
          const item = items.find((candidate) => candidate.types.includes("image/png"));
          if (!item) throw new Error("本次复制的剪贴板没有 PNG 图片");
          const png = await item.getType("image/png");
          return {
            mime: png.type,
            bytes: Array.from(new Uint8Array(await png.arrayBuffer())),
          };
        })()`);
        expect(clipboard.mime).toBe("image/png");
        const decoded = await sharp(Buffer.from(clipboard.bytes))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(decoded.info).toMatchObject({
          width: 2,
          height: 2,
          channels: 4,
        });
        expect(decoded.data).toStrictEqual(expectedRgba);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原图片复制自动化验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
