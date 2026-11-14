// @vitest-environment node
import { copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
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

/** 只观察浏览器实际发出的附件协议与完成回执，不改写请求或响应。 */
function observeAttachmentUpload(page: OriginalSessionBrowser) {
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
    commitRequested: () => commitRequestId !== undefined,
    async committedRef() {
      const requestId = commitRequestId;
      if (!requestId) throw new Error("原输入框未提交图片素材。");
      await vi.waitFor(() => expect(completed.has(requestId)).toBe(true));
      const response = await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      );
      if (typeof response.body !== "string")
        throw new Error("图片素材提交缺少实际 HTTP 回执。");
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

/** 暂停并继续服务端真实响应，保留原状态码、响应头和正文。 */
async function pauseOriginalImageResponse(
  page: OriginalSessionBrowser,
  imagePath: string,
) {
  let paused:
    | { requestId: string; networkId: string; status: unknown }
    | undefined;
  let continued = false;
  const completed = new Set<string>();
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  const continueResponse = (requestId: string) => {
    const operation = page.cdp.send(
      "Fetch.continueResponse",
      { requestId },
      page.target.sessionId,
    );
    continuations.push(operation);
    void operation.catch((error: unknown) => failures.push(error));
    return operation;
  };
  const releasePaused = page.cdp.on(
    "Fetch.requestPaused",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = params.request;
      if (
        request &&
        typeof request === "object" &&
        "postData" in request &&
        typeof request.postData === "string"
      ) {
        const payload = JSON.parse(request.postData);
        if (
          !paused &&
          payload.service === "file" &&
          payload.method === "readMediaPreview" &&
          payload.args?.[0]?.path === imagePath &&
          typeof params.networkId === "string"
        ) {
          paused = {
            requestId: params.requestId,
            networkId: params.networkId,
            status: params.responseStatusCode,
          };
          return;
        }
      }
      void continueResponse(params.requestId);
    },
  );
  const releaseCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        completed.add(params.requestId);
    },
  );
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [{ urlPattern: "*/api/code-ui/rpc", requestStage: "Response" }],
    },
    page.target.sessionId,
  );
  return {
    async waitForResponse() {
      await vi.waitFor(() => {
        expect(failures).toEqual([]);
        expect(paused).toMatchObject({ status: 200 });
      });
    },
    async resume() {
      if (!paused) throw new Error("未暂停添加图片触发的原件读取。");
      const { requestId, networkId } = paused;
      await continueResponse(requestId);
      continued = true;
      await vi.waitFor(() => expect(completed.has(networkId)).toBe(true));
      // 等浏览器消费已完成的原响应并提交下一次绘制，再读取原组件 DOM。
      await page.evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
      );
    },
    async dispose() {
      if (paused && !continued) await continueResponse(paused.requestId);
      await Promise.all(continuations);
      await page.cdp.send("Fetch.disable", {}, page.target.sessionId);
      releasePaused();
      releaseCompleted();
      if (failures.length)
        throw new AggregateError(failures, "原图片读取响应未全部继续。");
    },
  };
}

async function addLoadedPreviewImage(page: OriginalSessionBrowser) {
  const imageSelector = '[data-testid="preview-pane"] [data-image-preview] img';
  await vi.waitFor(
    async () => {
      const loaded = await page.evaluate<boolean>(`(() => {
        const image = document.querySelector(${JSON.stringify(imageSelector)});
        const composer = document.querySelector('[role="textbox"][contenteditable="true"]');
        return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && composer);
      })()`);
      expect(
        loaded,
        JSON.stringify({
          pageErrors: page.pageErrors,
          requests: page.requests,
        }),
      ).toBe(true);
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
  const addSelector = '[data-image-preview-add][role="menuitem"]';
  await vi.waitFor(async () => {
    const action = await page.evaluate(`(() => {
      const item = document.querySelector(${JSON.stringify(addSelector)});
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
  await clickOn(page.cdp, page.target.sessionId, { selector: addSelector });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原图片预览进入会话素材 integration",
  () => {
    it("原预览实际加载PNG后添加到聊天，原SessionPane生成已就绪图片素材与真实附件引用", async () => {
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
        const filename = "预览添加图片.png";
        const imagePath = join(host.workspacePath, filename);
        await copyFile(
          fileURLToPath(new URL("../public/app-icon.png", import.meta.url)),
          imagePath,
        );
        const imageFile = await stat(imagePath);
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
            path: imagePath,
            title: filename,
            mediaType: "image/png",
          },
        });
        const page = browser;
        const upload = observeAttachmentUpload(page);
        releaseObservations = () => upload.dispose();
        await page.cdp.send("Network.enable", {}, page.target.sessionId);
        await addLoadedPreviewImage(page);

        await vi.waitFor(
          async () => {
            const materials = await page.evaluate(`(() => {
              const images = Array.from(document.querySelectorAll('[data-composer-attachment-kind="image"]'));
              return images.map((chip) => {
                const image = chip.querySelector("img");
                return {
                  status: chip.getAttribute("data-upload-status"),
                  filename: image?.alt,
                  loaded: Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
                };
              });
            })()`);
            expect(
              materials,
              JSON.stringify({
                pageErrors: page.pageErrors,
                requests: page.requests,
                toast: await page.evaluate(
                  'document.getElementById("zcode-toast-host")?.innerText ?? ""',
                ),
              }),
            ).toEqual([{ status: "ready", filename, loaded: true }]);
          },
          { timeout: 30_000 },
        );
        expect(upload.plan()).toMatchObject({
          sessionId: host.sessionId,
          fileName: filename,
          mime: "image/png",
          totalBytes: imageFile.size,
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
        throw new AggregateError(failures, "原图片素材验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);

    it("关闭原预览标签后继续迟到原响应，不追加素材并保留同一输入框和正文", async () => {
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
      let interception:
        | Awaited<ReturnType<typeof pauseOriginalImageResponse>>
        | undefined;
      let releaseObservations: (() => void) | undefined;
      const failures: unknown[] = [];
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
        });
        const filename = "关闭前添加图片.png";
        const imagePath = join(host.workspacePath, filename);
        await copyFile(
          fileURLToPath(new URL("../public/app-icon.png", import.meta.url)),
          imagePath,
        );
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
            path: imagePath,
            title: filename,
            mediaType: "image/png",
          },
        });
        const page = browser;
        await vi.waitFor(
          async () => {
            expect(
              await page.evaluate(`(() => {
            const image = document.querySelector('[data-image-preview] img');
            const input = document.querySelector('[role="textbox"][contenteditable="true"]');
            return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && input);
          })()`),
              JSON.stringify(page.pageErrors),
            ).toBe(true);
          },
          { timeout: 60_000 },
        );
        const body = "关闭预览仍然保留的正文";
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[role="textbox"][contenteditable="true"]',
        });
        await typeText(page.cdp, page.target.sessionId, body);
        expect(
          await page.evaluate(`(() => {
          const input = document.querySelector('[role="textbox"][contenteditable="true"]');
          const pane = input?.closest('[data-testid^="v4-session-pane"]');
          window.__codeImageCloseInput = input;
          window.__codeImageClosePane = pane;
          return Boolean(input && pane && input.textContent === ${JSON.stringify(body)});
        })()`),
        ).toBe(true);
        const upload = observeAttachmentUpload(page);
        releaseObservations = () => upload.dispose();
        await page.cdp.send("Network.enable", {}, page.target.sessionId);
        interception = await pauseOriginalImageResponse(page, imagePath);
        await addLoadedPreviewImage(page);
        await interception.waitForResponse();
        await clickOn(page.cdp, page.target.sessionId, {
          selector: `button[aria-label=${JSON.stringify(`关闭 ${filename}`)}]`,
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'document.querySelector("[data-image-preview]") === null',
            ),
          ).toBe(true),
        );
        await interception.resume();
        expect(
          await page.evaluate(`(() => {
          const input = document.querySelector('[role="textbox"][contenteditable="true"]');
          return {
            sameInput: input === window.__codeImageCloseInput,
            samePane: input?.closest('[data-testid^="v4-session-pane"]') === window.__codeImageClosePane,
            text: input?.textContent,
            materials: document.querySelectorAll("[data-composer-attachment-kind]").length,
          };
        })()`),
          JSON.stringify(page.pageErrors),
        ).toEqual({
          sameInput: true,
          samePane: true,
          text: body,
          materials: 0,
        });
        expect(upload.plan()).toBeUndefined();
        expect(upload.commitRequested()).toBe(false);
      } catch (error) {
        failures.push(error);
      } finally {
        releaseObservations?.();
        for (const close of [
          () => interception?.dispose(),
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
        throw new AggregateError(failures, "关闭图片预览验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);

    it("新草稿预热独立Task后添加原图片，素材归属预热Task且正文与草稿界面保留", async () => {
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
        const filename = "新草稿图片.png";
        const imagePath = join(host.workspacePath, filename);
        await copyFile(
          fileURLToPath(new URL("../public/app-icon.png", import.meta.url)),
          imagePath,
        );
        const imageFile = await stat(imagePath);
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
          newDraft: true,
          initialPreview: {
            path: imagePath,
            title: filename,
            mediaType: "image/png",
          },
        });
        const page = browser;
        let prewarmTaskId = "";
        await vi.waitFor(
          async () => {
            const acks = page.sessionCreateAcks.map((response) => {
              if (
                !response ||
                typeof response !== "object" ||
                !("result" in response)
              )
                throw new Error("真实 createSession HTTP 回执无效。");
              return protocol.commandAckSchema.parse(response.result);
            });
            const accepted = acks.find(
              (ack) =>
                ack.status === "accepted" &&
                ack.result?.type === "createSession",
            );
            expect(accepted, JSON.stringify(page.pageErrors)).toMatchObject({
              status: "accepted",
              result: { type: "createSession" },
            });
            if (accepted?.result?.type !== "createSession")
              throw new Error("新草稿尚未得到真实预热 Task。");
            prewarmTaskId = accepted.result.sessionId;
            expect(
              await page.evaluate(`(() => {
            const pane = document.querySelector('[data-testid="v4-session-pane-actual-model-menu-pane"]');
            const input = pane?.querySelector('[role="textbox"][contenteditable="true"]');
            return Boolean(pane?.dataset.sessionId === "draft" && input);
          })()`),
              JSON.stringify(page.pageErrors),
            ).toBe(true);
          },
          { timeout: 60_000 },
        );
        expect(prewarmTaskId).not.toBe(host.sessionId);
        const body = "新草稿添加图片时保留这段正文";
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[role="textbox"][contenteditable="true"]',
        });
        await typeText(page.cdp, page.target.sessionId, body);
        const upload = observeAttachmentUpload(page);
        releaseObservations = () => upload.dispose();
        await addLoadedPreviewImage(page);
        await vi.waitFor(
          async () => {
            expect(
              await page.evaluate(`(() => {
            const pane = document.querySelector('[data-testid="v4-session-pane-actual-model-menu-pane"]');
            const input = pane?.querySelector('[role="textbox"][contenteditable="true"]');
            const images = Array.from(pane?.querySelectorAll('[data-composer-attachment-kind="image"]') ?? []);
            return {
              publicSessionId: pane?.dataset.sessionId,
              text: input?.textContent,
              materials: images.map((chip) => ({
                status: chip.getAttribute("data-upload-status"),
                filename: chip.querySelector("img")?.alt,
              })),
            };
          })()`),
              JSON.stringify(page.pageErrors),
            ).toEqual({
              publicSessionId: "draft",
              text: body,
              materials: [{ status: "ready", filename }],
            });
          },
          { timeout: 30_000 },
        );
        expect(upload.plan()).toMatchObject({
          sessionId: prewarmTaskId,
          fileName: filename,
          mime: "image/png",
          totalBytes: imageFile.size,
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
        throw new AggregateError(failures, "新草稿图片素材验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
