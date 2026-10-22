// @vitest-environment node
import { writeFile } from "node:fs/promises";
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

/** 只观察原输入框发出的真实上传请求和 HTTP 完成回执。 */
function observeSvgAttachmentUpload(page: OriginalSessionBrowser) {
  let plan: Record<string, unknown> | undefined;
  let commitRequestId: string | undefined;
  const completed = new Set<string>();
  const releaseRequest = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      const request = params.request;
      if (
        sessionId !== page.target.sessionId ||
        !request ||
        typeof request !== "object" ||
        !("postData" in request) ||
        typeof request.postData !== "string"
      )
        return;
      const payload = JSON.parse(request.postData);
      if (payload.service !== "zcodeAgentService") return;
      if (payload.method === "attachmentBeginV4") plan = payload.args?.[0];
      if (
        payload.method === "attachmentCommitV4" &&
        typeof params.requestId === "string"
      )
        commitRequestId = params.requestId;
    },
  );
  const releaseCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string" &&
        params.requestId === commitRequestId
      )
        completed.add(params.requestId);
    },
  );
  return {
    plan: () => plan,
    async committedRef() {
      const requestId = commitRequestId;
      if (!requestId) throw new Error("原输入框未提交 SVG 图片素材。");
      await vi.waitFor(() => expect(completed.has(requestId)).toBe(true));
      const response = await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      );
      if (typeof response.body !== "string")
        throw new Error("SVG 素材提交缺少实际 HTTP 回执。");
      const body = JSON.parse(
        response.base64Encoded
          ? Buffer.from(response.body, "base64").toString("utf8")
          : response.body,
      );
      return body.result?.ref;
    },
    dispose() {
      releaseRequest();
      releaseCompleted();
    },
  };
}

async function addLoadedSvgPreview(page: OriginalSessionBrowser) {
  const imageSelector = '[data-testid="preview-pane"] [data-image-preview] img';
  await vi.waitFor(
    async () => {
      const observed = await page.evaluate<{
        image: { loaded: boolean; width: number; height: number } | null;
        composerExists: boolean;
        paneText: string;
      }>(`(() => {
        const pane = document.querySelector('[data-testid="preview-pane"]');
        const image = document.querySelector(${JSON.stringify(imageSelector)});
        return {
          image: image ? {
            loaded: image.complete,
            width: image.naturalWidth,
            height: image.naturalHeight,
          } : null,
          composerExists: Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')),
          paneText: (pane?.innerText ?? "").replace(/data:[^\\s"'<>]+/gu, "[媒体来源]").slice(0, 600),
        };
      })()`);
      const diagnostic = JSON.stringify({
        ...observed,
        pageErrors: page.pageErrors,
      });
      expect(observed.image, diagnostic).toEqual({
        loaded: true,
        width: 96,
        height: 48,
      });
      expect(observed.composerExists, diagnostic).toBe(true);
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
  const selector = '[data-image-preview-add][role="menuitem"]';
  await vi.waitFor(async () => {
    const action = await page.evaluate(`(() => {
      const item = document.querySelector(${JSON.stringify(selector)});
      return {
        label: item?.textContent.trim(),
        enabled: Boolean(item && !item.hasAttribute("data-disabled")),
      };
    })()`);
    expect(action, JSON.stringify(page.pageErrors)).toEqual({
      label: "添加到聊天",
      enabled: true,
    });
  });
  await clickOn(page.cdp, page.target.sessionId, { selector });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 SVG 预览进入会话素材 integration",
  () => {
    it("原文件预览添加 SVG 后原 Composer 生成就绪图片素材和保留完整原件大小的实际附件引用", async () => {
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
      let releaseObservations: (() => void) | undefined;
      const failures: unknown[] = [];
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
        });
        const filename = "原始编码-SVG素材.svg";
        const original = Buffer.from(
          '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48">\r\n' +
            "<title>原始图片素材🙂</title>\r\n" +
            '<rect width="96" height="48" fill="#2367ab"/>\r\n' +
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
        const page = browser;
        const upload = observeSvgAttachmentUpload(page);
        releaseObservations = () => upload.dispose();
        await page.cdp.send("Network.enable", {}, page.target.sessionId);

        await addLoadedSvgPreview(page);

        await vi.waitFor(
          async () => {
            const observed = await page.evaluate<{
              materials: unknown[];
              readableText: string;
            }>(`(() => ({
              materials: Array.from(document.querySelectorAll('[data-composer-attachment-kind]')).map((chip) => {
                const image = chip.querySelector("img");
                return {
                  kind: chip.getAttribute("data-composer-attachment-kind"),
                  status: chip.getAttribute("data-upload-status"),
                  filename: image?.alt,
                  loaded: Boolean(image?.complete),
                  width: image?.naturalWidth,
                  height: image?.naturalHeight,
                };
              }),
              readableText: document.body.innerText.replace(/data:[^\\s"'<>]+/gu, "[媒体来源]").slice(-1200),
            }))()`);
            const plan = upload.plan();
            expect(
              observed.materials,
              JSON.stringify({
                readableText: observed.readableText,
                plan: plan && {
                  fileName: plan.fileName,
                  mime: plan.mime,
                  totalBytes: plan.totalBytes,
                },
                pageErrors: page.pageErrors,
              }),
            ).toEqual([
              {
                kind: "image",
                status: "ready",
                filename,
                loaded: true,
                width: 96,
                height: 48,
              },
            ]);
          },
          { timeout: 30_000 },
        );
        expect(upload.plan()).toMatchObject({
          sessionId: host.sessionId,
          fileName: filename,
          mime: "image/svg+xml",
          totalBytes: original.length,
        });
        expect(await upload.committedRef()).toMatch(/^code-attachment:/u);
      } catch (error) {
        failures.push(error);
      } finally {
        releaseObservations?.();
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
        throw new AggregateError(failures, "原 SVG 图片素材验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
