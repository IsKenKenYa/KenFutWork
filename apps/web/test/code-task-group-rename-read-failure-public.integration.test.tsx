// @vitest-environment node
import { join } from "node:path";
import {
  codeTaskGroupSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { selectAll } from "./setup/code-public-browser-actions.js";
import {
  createGroupFromUi,
  dismissGroupSetup,
  expectContentPreserved,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const rpcSchema = z.object({
  service: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
});
const renameInputSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  expectedRevision: z.number().int().nonnegative(),
});
type SaveResponse = {
  requestId: string;
  networkId: string;
  status: number;
  input: z.infer<typeof renameInputSchema>;
};

function titleInput(groupId: string) {
  return `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid="task-group-title-input"]`;
}

function requestRpc(request: unknown) {
  const { url, postData } = z
    .object({ url: z.string(), postData: z.string().optional() })
    .parse(request);
  if (new URL(url).pathname !== "/api/code-ui/rpc") return null;
  return postData ? rpcSchema.parse(JSON.parse(postData)) : null;
}

async function enterRename(page: OriginalSessionBrowser, groupId: string) {
  const selector = `[data-grouped-group-header-id=${JSON.stringify(groupId)}]`;
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(async () => {
        const header = document.querySelector(${JSON.stringify(selector)});
        if (!header) return null;
        header.scrollIntoView({ block: "center" });
        await new Promise(requestAnimationFrame);
        const rect = header.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && header.contains(hit) ? { x, y } : null;
      })()`,
    );
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原分组标题尚未显示。");
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  const renameSelector = '[data-testid="task-group-rename"]';
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(renameSelector)})?.checkVisibility())`,
      ),
    ).toBe(true),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: renameSelector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(titleInput(groupId))})?.checkVisibility())`,
      ),
    ).toBe(true),
  );
}

async function observeInput(page: OriginalSessionBrowser, groupId: string) {
  const selector = titleInput(groupId);
  const { result } = z
    .object({ result: z.object({ objectId: z.string() }) })
    .parse(
      await page.cdp.send(
        "Runtime.evaluate",
        { expression: `document.querySelector(${JSON.stringify(selector)})` },
        page.target.sessionId,
      ),
    );
  const read = async () =>
    z.object({ result: z.object({ value: z.unknown() }) }).parse(
      await page.cdp.send(
        "Runtime.callFunctionOn",
        {
          objectId: result.objectId,
          arguments: [{ value: selector }],
          returnByValue: true,
          functionDeclaration: `function (selector) {
              const input = document.querySelector(selector);
              return {
                sameNode: this === input,
                connected: this.isConnected,
                focused: this === document.activeElement,
                busy: this.getAttribute('aria-busy') ?? 'false',
                disabled: this.disabled,
                readOnly: this.readOnly,
                value: this.value,
                activeElement: document.activeElement?.outerHTML,
                input: this.outerHTML,
                currentInput: input?.outerHTML,
                group: input?.closest('[data-task-group-id]')?.outerHTML,
              };
            }`,
        },
        page.target.sessionId,
      ),
    ).result.value;
  return {
    read,
    async expectState(title: string, busy: boolean) {
      await vi.waitFor(
        async () => {
          const input = await read();
          expect(
            input,
            JSON.stringify({
              input,
              requests: page.requests,
              errors: page.pageErrors,
            }),
          ).toMatchObject({
            sameNode: true,
            connected: true,
            focused: true,
            busy: String(busy),
            disabled: false,
            readOnly: false,
            value: title,
          });
        },
        { timeout: 30_000 },
      );
    },
    async replace(title: string) {
      await clickOn(page.cdp, page.target.sessionId, { selector });
      await selectAll(page);
      await typeText(page.cdp, page.target.sessionId, title);
      await vi.waitFor(async () => {
        const input = await read();
        expect(input, JSON.stringify(input)).toMatchObject({ value: title });
      });
    },
    async close() {
      await page.cdp.send(
        "Runtime.releaseObject",
        { objectId: result.objectId },
        page.target.sessionId,
      );
    },
  };
}

/** 故障只作用于当前浏览器；可信 Host 的独立 HTTP 连接始终保持可用。 */
async function failReadAfterSave(
  page: OriginalSessionBrowser,
  groupId: string,
) {
  const saves: SaveResponse[] = [];
  const reads: Array<{
    networkId: string;
    status: number;
    afterFailure: boolean;
  }> = [];
  const completed = new Set<string>();
  const networkFailures = new Map<string, unknown>();
  const failures: unknown[] = [];
  const commands: Promise<unknown>[] = [];
  let held: SaveResponse | undefined;
  let released = false;
  let failNextRead = false;
  let failedRead: { requestId: string; networkId: string } | undefined;
  const send = (method: string, params: Record<string, unknown>) => {
    const command = page.cdp.send(method, params, page.target.sessionId);
    commands.push(command);
    void command.catch((cause: unknown) => failures.push(cause));
    return command;
  };
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    const atResponse =
      typeof params.responseStatusCode === "number" ||
      typeof params.responseErrorReason === "string";
    try {
      const rpc = requestRpc(params.request);
      if (rpc?.service === "task-groups") {
        const networkId = z.string().parse(params.networkId);
        if (!atResponse && rpc.method === "read" && failNextRead) {
          failNextRead = false;
          failedRead = { requestId: params.requestId, networkId };
          void send("Fetch.failRequest", {
            requestId: params.requestId,
            errorReason: "ConnectionReset",
          });
          return;
        }
        if (atResponse && rpc.method === "read")
          reads.push({
            networkId,
            status: z.number().parse(params.responseStatusCode),
            afterFailure: Boolean(failedRead),
          });
        if (atResponse && rpc.method === "save") {
          const input = renameInputSchema.parse(rpc.args[0]);
          if (input.id === groupId) {
            const response = {
              requestId: params.requestId,
              networkId,
              status: z.number().parse(params.responseStatusCode),
              input,
            };
            saves.push(response);
            if (saves.length === 1 && response.status === 200) {
              held = response;
              return;
            }
          }
        }
      }
    } catch (cause) {
      failures.push(cause);
    }
    void send(atResponse ? "Fetch.continueResponse" : "Fetch.continueRequest", {
      requestId: params.requestId,
    });
  });
  const offCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        completed.add(params.requestId);
    },
  );
  const offFailed = page.cdp.on(
    "Network.loadingFailed",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        networkFailures.set(params.requestId, params);
    },
  );
  await page.cdp.send("Network.enable", {}, page.target.sessionId);
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [
        { urlPattern: "*/api/code-ui/rpc", requestStage: "Request" },
        { urlPattern: "*/api/code-ui/rpc", requestStage: "Response" },
      ],
    },
    page.target.sessionId,
  );
  const diagnostics = () =>
    JSON.stringify({
      saves,
      reads,
      failedRead,
      networkFailures: [...networkFailures.values()],
      errors: page.pageErrors,
      requests: page.requests,
      failures: failures.map(String),
    });
  return {
    async waitForFirst() {
      return vi.waitFor(
        () => {
          expect(failures, diagnostics()).toEqual([]);
          expect(saves, diagnostics()).toHaveLength(1);
          expect(saves[0]?.status, diagnostics()).toBe(200);
          if (!held) throw new Error(`真实保存响应尚未暂停：${diagnostics()}`);
          return held;
        },
        { timeout: 30_000 },
      );
    },
    async releaseAndFailRead() {
      if (!held) throw new Error("真实保存响应尚未暂停。");
      const response = held;
      released = true;
      failNextRead = true;
      await send("Fetch.continueResponse", { requestId: response.requestId });
      await vi.waitFor(
        () => {
          expect(failures, diagnostics()).toEqual([]);
          if (!failedRead)
            throw new Error(`原分组尚未重新读取：${diagnostics()}`);
          expect(
            networkFailures.get(failedRead.networkId),
            diagnostics(),
          ).toMatchObject({
            errorText: "net::ERR_CONNECTION_RESET",
            canceled: false,
          });
          expect(networkFailures.size, diagnostics()).toBe(1);
          expect(completed.has(response.networkId), diagnostics()).toBe(true);
        },
        { timeout: 30_000 },
      );
    },
    async waitForBoth() {
      return vi.waitFor(
        () => {
          expect(failures, diagnostics()).toEqual([]);
          expect(saves, diagnostics()).toHaveLength(2);
          expect(
            saves.map((response) => response.status),
            diagnostics(),
          ).toEqual([200, 200]);
          expect(
            saves.every((response) => completed.has(response.networkId)),
            diagnostics(),
          ).toBe(true);
          return [...saves];
        },
        { timeout: 30_000 },
      );
    },
    async expectReadingRecovered() {
      await vi.waitFor(() => {
        expect(failures, diagnostics()).toEqual([]);
        expect(
          reads.some(
            (read) =>
              read.afterFailure &&
              read.status === 200 &&
              completed.has(read.networkId),
          ),
          diagnostics(),
        ).toBe(true);
        expect(networkFailures.size, diagnostics()).toBe(1);
        expect(failNextRead, diagnostics()).toBe(false);
      });
    },
    async readResult(response: SaveResponse) {
      const payload = z
        .object({ body: z.string(), base64Encoded: z.boolean().optional() })
        .parse(
          await page.cdp.send(
            "Network.getResponseBody",
            { requestId: response.networkId },
            page.target.sessionId,
          ),
        );
      const body = payload.base64Encoded
        ? Buffer.from(payload.body, "base64").toString("utf8")
        : payload.body;
      return codeTaskGroupSchema.parse(
        z.object({ result: z.unknown() }).parse(JSON.parse(body)).result,
      );
    },
    async close() {
      for (const close of [
        () =>
          held && !released
            ? send("Fetch.continueResponse", { requestId: held.requestId })
            : undefined,
        () => Promise.all(commands),
        () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
      ]) {
        try {
          await close();
        } catch (cause) {
          failures.push(cause);
        }
      }
      offPaused();
      offCompleted();
      offFailed();
      if (failures.length)
        throw new AggregateError(failures, "原名称网络故障资源关闭失败");
    },
  };
}

async function expectOriginalWork(context: TaskGroupPublicPageContext) {
  const {
    host,
    model,
    scopeBefore,
    snapshotBefore,
    previewTitle,
    modelRequestCountBefore,
  } = context;
  await expectContentPreserved(context);
  expect(await readScope(host)).toEqual(scopeBefore);
  const snapshot = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(snapshot.rows.window).toEqual(snapshotBefore.rows.window);
  expect(snapshot.taskControl).toEqual(snapshotBefore.taskControl);
  const file = await host.client.request("/api/code-ui/rpc", {
    service: "file",
    method: "readTextFile",
    args: [
      {
        path: join(host.workspacePath, previewTitle),
        viewerScope: { kind: "task", taskId: host.sessionId },
      },
    ],
  });
  expect(file.status, JSON.stringify(file.body)).toBe(200);
  expect(file.body.result).toMatchObject({
    content: "分组操作保留原内容\n",
    truncated: false,
  });
  expect(model.requests).toHaveLength(modelRequestCountBefore);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组名称保存成功后读取失败 integration",
  () => {
    it("保存A成功后读取发生网络故障，较新草稿B保持可编辑并按新修订明确保存", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host } = context;
          const group = await createGroupFromUi(context);
          await dismissGroupSetup(page);
          const before = await readGroups(host);
          const firstTitle = "首次已确认保存的名称 A";
          const nextTitle = "读取恢复后明确保存的名称 B";
          await enterRename(page, group.id);
          const network = await failReadAfterSave(page, group.id);
          let input: Awaited<ReturnType<typeof observeInput>> | undefined;
          try {
            const editor = await observeInput(page, group.id);
            input = editor;
            await editor.replace(firstTitle);
            await editor.expectState(firstTitle, false);
            await pressKey(page.cdp, page.target.sessionId, "Enter");
            const first = await network.waitForFirst();
            expect(first.input).toEqual({
              id: group.id,
              title: firstTitle,
              expectedRevision: before.revision,
            });
            await editor.expectState(firstTitle, true);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector('[data-task-group-id=${JSON.stringify(group.id)}]')?.getAttribute('data-task-group-title')`,
                ),
              ).toBe(firstTitle),
            ); // 此前真实广播已完成读取，后续故障只覆盖保存回执后的重读。
            const savedFirst = await readGroups(host);
            expect(savedFirst.revision).toBe(before.revision + 1);
            expect(savedFirst.groups).toEqual([
              { ...group, title: firstTitle, updatedAt: expect.any(Number) },
            ]);
            await editor.replace(nextTitle);
            await editor.expectState(nextTitle, true);
            await expectOriginalWork(context);
            await network.releaseAndFailRead();
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `Array.from(document.querySelectorAll('[data-testid="sidebar"] [role="alert"]'))
                  .filter(alert => alert.checkVisibility()).map(alert => alert.textContent).join(' ')`,
                ),
                JSON.stringify(page.pageErrors),
              ).toMatch(/fetch|网络|Network/i),
            );
            await editor.expectState(nextTitle, false);
            expect(await network.readResult(first)).toMatchObject({
              id: group.id,
              title: firstTitle,
            });
            const afterFailure = await readGroups(host);
            expect(afterFailure).toEqual(savedFirst);
            await expectOriginalWork(context);
            await editor.expectState(nextTitle, false);
            await pressKey(page.cdp, page.target.sessionId, "Enter");
            const responses = await network.waitForBoth();
            expect(responses.map((response) => response.input)).toEqual([
              {
                id: group.id,
                title: firstTitle,
                expectedRevision: before.revision,
              },
              {
                id: group.id,
                title: nextTitle,
                expectedRevision: before.revision + 1,
              },
            ]);
            const second = responses[1];
            if (!second) throw new Error("再次Enter缺少真实保存回执。");
            expect(await network.readResult(second)).toMatchObject({
              id: group.id,
              title: nextTitle,
            });
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector('[data-task-group-id=${JSON.stringify(group.id)}]')?.getAttribute('data-task-group-title')`,
                ),
              ).toBe(nextTitle),
            );
            await network.expectReadingRecovered();
            const after = await readGroups(host);
            expect(after.revision).toBe(before.revision + 2);
            expect(after.groups).toEqual([
              { ...group, title: nextTitle, updatedAt: expect.any(Number) },
            ]);
            expect(after.members).toEqual(before.members);
            expect(after.order).toEqual(before.order);
            await expectOriginalWork(context);
          } finally {
            try {
              await network.close();
            } finally {
              await input?.close();
            }
          }
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root、真实网络故障、HTTP/SSE/临时PG及资源关闭期限。
  },
);
