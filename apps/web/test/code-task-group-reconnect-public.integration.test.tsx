// @vitest-environment node
import {
  codeTaskGroupSaveResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  createGroupFromUi,
  dismissGroupSetup,
  expectContentPreserved,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const requestFactSchema = z.object({
  requestId: z.string(),
  path: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  state: z.string(),
  error: z.string().optional(),
});

function requestFacts(page: OriginalSessionBrowser) {
  return z.array(requestFactSchema).parse(page.requests);
}

async function connectionFor(page: OriginalSessionBrowser, requestId: string) {
  const response = z
    .object({ postData: z.string() })
    .parse(
      await page.cdp.send(
        "Network.getRequestPostData",
        { requestId },
        page.target.sessionId,
      ),
    );
  return z
    .object({ connectionId: z.uuid() })
    .parse(JSON.parse(response.postData)).connectionId;
}

async function setOffline(page: OriginalSessionBrowser, offline: boolean) {
  // 仅控制本例独占浏览器的真实网络，不修改HTTP正文、原组件或服务状态。
  await page.cdp.send(
    "Network.emulateNetworkConditions",
    {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    },
    page.target.sessionId,
  );
}

async function whileBrowserDisconnected(
  page: OriginalSessionBrowser,
  work: () => Promise<void>,
) {
  const stream = requestFacts(page)
    .filter(
      (request) =>
        request.path === "/api/code-ui/events" &&
        request.status === 200 &&
        request.state === "pending",
    )
    .at(-1);
  if (!stream) throw new Error("原界面缺少活动的真实SSE连接。");
  const failures: unknown[] = [];
  try {
    await setOffline(page, true);
    await page.cdp.send("Page.stopLoading", {}, page.target.sessionId);
    await vi.waitFor(
      () => {
        const current = requestFacts(page).find(
          (request) => request.requestId === stream.requestId,
        );
        expect(current, JSON.stringify(page.pageErrors)).toMatchObject({
          state: "failed",
        });
        expect(current?.error).toMatch(/^net::ERR_/u);
      },
      { timeout: 10_000 },
    ); // 观察原SSE的真实loadingFailed后才允许另一可信连接修改分组。
    await work();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await setOffline(page, false);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "原界面断线操作或网络恢复失败", {
      cause: failures[0],
    });
}

async function expectReconnected(
  page: OriginalSessionBrowser,
  previous: ReadonlySet<string>,
  previousConnection: string,
) {
  const handshake = await vi.waitFor(
    () => {
      const requests = requestFacts(page).filter(
        (request) => !previous.has(request.requestId),
      );
      const diagnostics = JSON.stringify({
        requests,
        pageErrors: page.pageErrors,
      });
      expect(
        requests.some(
          (request) =>
            request.path === "/api/code-ui/events" && request.status === 200,
        ),
        diagnostics,
      ).toBe(true);
      const found = requests.find(
        (request) =>
          request.service === "zcodeAgentService" &&
          request.method === "initializeConversationV4" &&
          request.state === "finished" &&
          request.status === 200,
      );
      if (!found) throw new Error(`原连接尚未完成真实恢复握手：${diagnostics}`);
      expect(
        requests.some(
          (request) =>
            request.service === "window-controller" &&
            request.method === "subscribeControllerV4" &&
            request.status === 200 &&
            request.state === "finished",
        ),
        diagnostics,
      ).toBe(true);
      return found;
    },
    { timeout: 15_000 },
  ); // 等待真实网络恢复、新SSE、原握手和Controller订阅；不重载页面。
  const connection = await connectionFor(page, handshake.requestId);
  expect(connection).not.toBe(previousConnection);
  return connection;
}

async function expectContentPanelsPreserved({
  page,
  host,
  previewTitle,
}: TaskGroupPublicPageContext) {
  expect(
    await page.evaluate(`(() => {
      const before = window.__taskGroupPublicBefore;
      const pane = document.querySelector('[data-session-id=${JSON.stringify(host.sessionId)}]');
      const preview = document.querySelector('[data-testid="preview-pane"]');
      const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
      return {
        sessionPreserved: Boolean(pane && pane === window.__taskGroupReconnectSession && pane.isConnected),
        previewPreserved: Boolean(preview && preview === before.preview && preview.isConnected),
        tabPreserved: Boolean(tab && tab === before.tab && tab.isConnected),
        previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
      };
    })()`),
    JSON.stringify(page.pageErrors),
  ).toEqual({
    sessionPreserved: true,
    previewPreserved: true,
    tabPreserved: true,
    previewTitle,
  });
}

async function expectRestoredDraft({
  page,
  host,
  draft,
}: TaskGroupPublicPageContext) {
  // 原SessionPane在订阅error期间卸载Timeline及其Composer，恢复后验证同一Task草稿。
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const input = document.querySelector('[role="textbox"][contenteditable="true"]');
        return {
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          draft: input?.textContent,
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ taskId: host.sessionId, draft }),
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组断线恢复的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("断线期间另一连接改名，重连后原分组更新且Task草稿和文件保持", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const { page, host, model, scopeBefore, snapshotBefore } = context;
        const group = await createGroupFromUi(context);
        await dismissGroupSetup(page);
        await expectContentPreserved(context);
        await page.evaluate(`(() => {
          window.__taskGroupReconnectSession = document
            .querySelector('[role="textbox"][contenteditable="true"]')
            ?.closest('[data-session-id]');
        })()`);
        const before = await readGroups(host);
        const initial = requestFacts(page).find(
          (request) =>
            request.service === "zcodeAgentService" &&
            request.method === "initializeConversationV4" &&
            request.state === "finished" &&
            request.status === 200,
        );
        if (!initial) throw new Error("原界面缺少实际初始握手。");
        const initialConnection = await connectionFor(page, initial.requestId);
        const previous = new Set(
          requestFacts(page).map((request) => request.requestId),
        );
        const title = "断线期间另一连接保存的名称";
        const selector = `[data-task-group-id=${JSON.stringify(group.id)}]`;
        await whileBrowserDisconnected(page, async () => {
          const saved = await host.client.request("/api/code-ui/rpc", {
            service: "task-groups",
            method: "save",
            args: [{ id: group.id, expectedRevision: before.revision, title }],
          });
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const renamed = codeTaskGroupSaveResponseSchema.parse(
            saved.body,
          ).result;
          expect(renamed).toMatchObject({ id: group.id, title });
          const advanced = await readGroups(host);
          expect(advanced.revision).toBe(before.revision + 1);
          expect(advanced.groups).toEqual([renamed]);
          expect(advanced.members).toEqual(before.members);
          expect(advanced.order).toEqual(before.order);
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-task-group-title')`,
            ),
          ).toBe(group.title);
          await expectContentPanelsPreserved(context);
        });
        await expectReconnected(page, previous, initialConnection);
        await vi.waitFor(
          async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-task-group-title')`,
              ),
              JSON.stringify({
                requests: requestFacts(page),
                pageErrors: page.pageErrors,
              }),
            ).toBe(title),
          { timeout: 5_000 },
        ); // 原组织owner应重新读取错过的分组更新，不依赖Task身份发生变化。
        await expectContentPanelsPreserved(context);
        await expectRestoredDraft(context);
        expect(await readScope(host)).toEqual(scopeBefore);
        const snapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(snapshot.rows.window).toEqual(snapshotBefore.rows.window);
        expect(snapshot.taskControl).toEqual(snapshotBefore.taskControl);
        expect(
          requestFacts(page).filter(
            (request) =>
              !previous.has(request.requestId) &&
              request.service === "task-groups" &&
              request.method === "save",
          ),
        ).toEqual([]);
        const after = await readGroups(host);
        expect(after.revision).toBe(before.revision + 1);
        expect(after.groups).toHaveLength(1);
        expect(after.groups[0]).toMatchObject({ id: group.id, title });
        expect(model.requests).toEqual([]);
      });
    }, 180_000); // 原Root、独占浏览器、真实断线重连与HTTP/SSE/临时PG关闭期限。
  },
);
