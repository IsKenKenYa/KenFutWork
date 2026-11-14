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

function requestRpc(request: unknown) {
  const { postData, url } = z
    .object({ postData: z.string().optional(), url: z.string() })
    .parse(request);
  if (new URL(url).pathname !== "/api/code-ui/rpc") return null;
  return postData ? rpcSchema.parse(JSON.parse(postData)) : null;
}

function titleInput(groupId: string) {
  return `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid="task-group-title-input"]`;
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
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: renameSelector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(titleInput(groupId))})?.checkVisibility())`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
}

async function enterTitle(
  page: OriginalSessionBrowser,
  groupId: string,
  title: string,
  readInput: () => Promise<unknown>,
) {
  const selector = titleInput(groupId);
  const observations = [{ stage: "beforeClick", input: await readInput() }];
  await clickOn(page.cdp, page.target.sessionId, { selector });
  observations.push({ stage: "afterClick", input: await readInput() });
  await selectAll(page);
  observations.push({ stage: "afterSelectAll", input: await readInput() });
  await typeText(page.cdp, page.target.sessionId, title);
  observations.push({ stage: "afterType", input: await readInput() });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.value`,
      ),
      JSON.stringify({ observations, pageErrors: page.pageErrors }),
    ).toBe(title),
  );
  return observations;
}

async function expectTitleAndDraft(
  page: OriginalSessionBrowser,
  groupId: string,
  title: string,
  draft: string,
) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const group = document.querySelector('[data-task-group-id=${JSON.stringify(groupId)}]');
        return {
          title: group?.getAttribute('data-task-group-title'),
          draft: group?.querySelector('[data-testid="task-group-title-input"]')?.value,
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ title, draft }),
  );
}

async function observeTitleInput(
  page: OriginalSessionBrowser,
  groupId: string,
) {
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
              const current = document.querySelector(selector);
              const rect = this.getBoundingClientRect();
              const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              const hit = document.elementFromPoint(center.x, center.y);
              return {
                sameNode: this === current,
                connected: this.isConnected,
                focused: this === document.activeElement,
                busy: this.getAttribute('aria-busy') ?? 'false',
                ariaBusy: this.getAttribute('aria-busy'),
                disabled: this.disabled,
                readOnly: this.readOnly,
                value: this.value,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                centerHit: hit?.outerHTML,
                centerHitsInput: this === hit,
                activeElement: document.activeElement?.outerHTML,
                input: this.outerHTML,
                currentInput: current?.outerHTML,
                group: current?.closest('[data-task-group-id]')?.outerHTML,
                menus: Array.from(document.querySelectorAll('[role="menu"]'))
                  .map(menu => ({ visible: menu.checkVisibility(), html: menu.outerHTML })),
              };
            }`,
        },
        page.target.sessionId,
      ),
    ).result.value;
  return {
    read,
    async expectState(
      busy: boolean,
      value: string,
      observations: unknown[] = [],
    ) {
      await vi.waitFor(
        async () => {
          const observation = await read();
          expect(
            observation,
            JSON.stringify({
              observation,
              observations,
              requests: page.requests,
              pageErrors: page.pageErrors,
            }),
          ).toMatchObject({
            sameNode: true,
            connected: true,
            focused: true,
            busy: String(busy),
            disabled: false,
            readOnly: false,
            value,
          });
        },
        { timeout: 30_000 },
      );
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

/** 只暂停首次真实成功响应；继续时保留状态码、请求参数与响应字节。 */
async function holdRenameResponse(
  page: OriginalSessionBrowser,
  groupId: string,
) {
  const saves: SaveResponse[] = [];
  const readsAfterRelease = new Set<string>();
  const completed = new Set<string>();
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  let held: SaveResponse | undefined;
  let released = false;
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
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const rpc = requestRpc(params.request);
      if (rpc?.service === "task-groups" && rpc.method === "save") {
        const input = renameInputSchema.parse(rpc.args[0]);
        if (input.id === groupId && typeof params.networkId === "string") {
          const response = {
            requestId: params.requestId,
            networkId: params.networkId,
            status: z.number().parse(params.responseStatusCode),
            input,
          };
          saves.push(response);
          if (!held && response.status === 200) {
            held = response;
            return;
          }
        }
      }
    } catch (error) {
      failures.push(error);
    }
    void continueResponse(params.requestId);
  });
  const offRequested = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (
        !released ||
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      try {
        const rpc = requestRpc(params.request);
        if (rpc?.service === "task-groups" && rpc.method === "read")
          readsAfterRelease.add(params.requestId);
      } catch (error) {
        failures.push(error);
      }
    },
  );
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
  await page.cdp.send("Network.enable", {}, page.target.sessionId);
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [{ urlPattern: "*/api/code-ui/rpc", requestStage: "Response" }],
    },
    page.target.sessionId,
  );
  return {
    async waitForFirst(inspectInput: () => Promise<unknown>) {
      try {
        return await vi.waitFor(
          () => {
            expect(failures).toEqual([]);
            expect(saves).toHaveLength(1);
            if (!held) throw new Error("原名称保存尚未收到成功响应。");
            return held;
          },
          { timeout: 30_000 },
        );
      } catch (cause) {
        throw new Error(
          `首次名称保存没有成功回执：${JSON.stringify({
            input: await inspectInput(),
            saves,
            requests: page.requests,
            pageErrors: page.pageErrors,
            responseFailures: failures.map(String),
          })}`,
          { cause },
        );
      }
    },
    async release() {
      if (!held) throw new Error("原名称保存响应尚未暂停。");
      const response = held;
      released = true;
      await continueResponse(response.requestId);
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(completed.has(response.networkId)).toBe(true);
          expect([...readsAfterRelease].some((id) => completed.has(id))).toBe(
            true,
          );
        },
        { timeout: 30_000 },
      );
    },
    async waitForBoth() {
      return vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(saves).toHaveLength(2);
          expect(saves.map((save) => save.status)).toEqual([200, 200]);
          expect(saves.every((save) => completed.has(save.networkId))).toBe(
            true,
          );
          return [...saves];
        },
        { timeout: 30_000 },
      );
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
          held && !released ? continueResponse(held.requestId) : undefined,
        () => Promise.all(continuations),
        () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      offPaused();
      offRequested();
      offCompleted();
      if (failures.length)
        throw new AggregateError(failures, "原名称响应或释放失败");
    },
  };
}

async function expectOriginalWork(context: TaskGroupPublicPageContext) {
  const { host, model, scopeBefore, snapshotBefore, previewTitle } = context;
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
  expect(model.requests).toEqual([]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组名称保存等待期间的新草稿 integration",
  () => {
    it("原名称O提交A后等待期间改回O，成功响应保留新草稿且再次Enter按新修订保存O", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const { page, host } = context;
        const group = await createGroupFromUi(context);
        await dismissGroupSetup(page);
        const before = await readGroups(host);
        const originalTitle = group.title;
        const firstTitle = "首次明确保存的分组名称 A";
        await enterRename(page, group.id);
        const pending = await holdRenameResponse(page, group.id);
        let input: Awaited<ReturnType<typeof observeTitleInput>> | undefined;
        try {
          const observedInput = await observeTitleInput(page, group.id);
          input = observedInput;
          const firstEntry = await enterTitle(
            page,
            group.id,
            firstTitle,
            observedInput.read,
          );
          await observedInput.expectState(false, firstTitle, firstEntry);
          await pressKey(page.cdp, page.target.sessionId, "Enter");
          const first = await pending.waitForFirst(async () => ({
            current: await observedInput.read(),
            firstEntry,
          }));
          await observedInput.expectState(true, firstTitle);
          expect(first.input).toEqual({
            id: group.id,
            title: firstTitle,
            expectedRevision: before.revision,
          });
          const savedFirst = await readGroups(host);
          expect(savedFirst.revision).toBe(before.revision + 1);
          expect(savedFirst.groups).toEqual([
            { ...group, title: firstTitle, updatedAt: expect.any(Number) },
          ]);
          await enterTitle(page, group.id, originalTitle, observedInput.read);
          await expectTitleAndDraft(page, group.id, firstTitle, originalTitle);
          await expectOriginalWork(context);
          await pending.release();
          await observedInput.expectState(false, originalTitle);
          expect(await pending.readResult(first)).toMatchObject({
            id: group.id,
            title: firstTitle,
          });
          await expectTitleAndDraft(page, group.id, firstTitle, originalTitle);
          await observedInput.expectState(false, originalTitle);
          await pressKey(page.cdp, page.target.sessionId, "Enter");
          const responses = await pending.waitForBoth();
          expect(responses.map((response) => response.input)).toEqual([
            {
              id: group.id,
              title: firstTitle,
              expectedRevision: before.revision,
            },
            {
              id: group.id,
              title: originalTitle,
              expectedRevision: before.revision + 1,
            },
          ]);
          const second = responses[1];
          if (!second) throw new Error("再次Enter没有产生新的名称保存。");
          expect(await pending.readResult(second)).toMatchObject({
            id: group.id,
            title: originalTitle,
          });
          const after = await readGroups(host);
          expect(after.revision).toBe(before.revision + 2);
          expect(after.groups).toEqual([
            { ...group, updatedAt: expect.any(Number) },
          ]);
          expect(after.members).toEqual(before.members);
          expect(after.order).toEqual(before.order);
          await expectOriginalWork(context);
        } finally {
          try {
            await pending.close();
          } finally {
            await input?.close();
          }
        }
      });
    }, 180_000); // 原Root、实际保存响应暂停与HTTP/SSE/临时PG关闭期限。
  },
);
