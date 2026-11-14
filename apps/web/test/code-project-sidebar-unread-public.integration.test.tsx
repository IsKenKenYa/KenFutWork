// @vitest-environment node
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import { selectSidebarView } from "./setup/code-public-browser-actions.js";
import {
  type ProjectionContext,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

type Host = ProjectionContext["session"];
interface UnreadRootContext {
  host: Host;
  page: OriginalSessionBrowser;
  view?: "projects" | "timeline" | "grouped";
}

async function withUnreadRoot(
  { fixture, session }: ProjectionContext,
  work: (context: UnreadRootContext) => Promise<void>,
) {
  const page = await openOriginalSessionBrowser({
    backendBaseUrl: fixture.baseUrl,
    backendOrigin: fixture.origin,
    accessToken: await fixture.app.kernel.get("localAccess").getDesktopToken(),
    workspacePath: session.workspacePath,
    projectId: session.projectId,
    sessionId: session.sessionId,
    clientId: session.clientId,
    workspaceShell: true,
    beforeNavigate: async ({ cdp, target }) => {
      const preference = JSON.stringify({
        view: "projects",
        order: [],
        expanded: {},
      });
      await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(preference)});`,
        },
        target.sessionId,
      );
    },
  });
  const failures: unknown[] = [];
  try {
    await work({ host: session, page });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await page.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "原侧栏未读验证或浏览器关闭失败", {
      cause: failures[0],
    });
}

function taskRowSelector(host: Host, view = "projects") {
  const row = `[data-testid="task-item-${host.sessionId}"]`;
  return view === "projects"
    ? `section[data-project-id="${host.projectId}"] ${row}`
    : row;
}

async function clickTaskRow({ page, host, view }: UnreadRootContext) {
  const selector = taskRowSelector(host, view);
  const point = await vi.waitFor(
    async () => {
      const target = await page.evaluate<{
        x: number;
        y: number;
      } | null>(`(async () => {
      const row = document.querySelector(${JSON.stringify(selector)});
      if (!row?.checkVisibility()) return null;
      row.scrollIntoView({ block: 'center' });
      const first = row.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const rect = row.getBoundingClientRect();
      if (first.x !== rect.x || first.y !== rect.y || first.width !== rect.width || first.height !== rect.height)
        return null;
      const point = { x: rect.left + rect.width / 3, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return hit && row.contains(hit) && !hit.closest('button') ? point : null;
    })()`);
      expect(target, JSON.stringify(page.pageErrors)).not.toBeNull();
      return target;
    },
    { timeout: 30_000 },
  );
  if (!point) throw new Error("原Task行尚未进入可点击位置。");
  await clickOn(page.cdp, page.target.sessionId, point);
}

async function readUnreadAt(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [
      {
        taskId: host.sessionId,
        workspacePath: host.workspacePath,
        workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.result.taskId).toBe(host.sessionId);
  return response.body.result.unreadAt;
}

async function markUnreadFromOriginalMenu({
  page,
  host,
  view,
}: UnreadRootContext) {
  const selector = taskRowSelector(host, view);
  const point = await vi.waitFor(
    async () => {
      const target = await page.evaluate<{
        x: number;
        y: number;
      } | null>(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row?.checkVisibility()) return null;
    row.scrollIntoView({ block: 'center' });
    const rect = row.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
      expect(target, JSON.stringify(page.pageErrors)).not.toBeNull();
      return target;
    },
    { timeout: 30_000 },
  ); // 等待已完成真实Task进入原项目树后再打开菜单。
  if (!point) throw new Error("原Task行菜单入口不可见。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...point },
    page.target.sessionId,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  const action = await vi.waitFor(async () => {
    const target = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
        .find(node => node.checkVisibility() && node.textContent.trim() === '标记为未读');
      if (!item) return null;
      const rect = item.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    expect(target, JSON.stringify(page.pageErrors)).not.toBeNull();
    return target;
  });
  if (!action) throw new Error("原Task未读菜单项不可见。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...action },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.activeElement?.textContent?.trim()"),
    ).toBe("标记为未读"),
  );
  for (const type of ["keyDown", "keyUp"])
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      page.target.sessionId,
    );
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(
          'Array.from(document.querySelectorAll("[role=menu]")).filter(node => node.checkVisibility()).length',
        ),
      ).toBe(0),
    { timeout: 30_000 },
  );
  // 原菜单关闭后焦点回到Task行；点击原输入区结束行操作状态。
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[role="textbox"][contenteditable="true"]',
  });
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: 0, y: 0 },
    page.target.sessionId,
  );
}

async function expectTaskUnread(
  { page, host }: UnreadRootContext,
  unread: boolean,
) {
  const selector = taskRowSelector(host);
  await vi.waitFor(
    async () => {
      const state = await page.evaluate<{
        rowVisible: boolean;
        unreadVisible: boolean;
      }>(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      return { rowVisible: Boolean(row?.checkVisibility()), unreadVisible: Boolean(row?.querySelector('[data-unread-indicator]')?.checkVisibility()) };
    })()`);
      const display =
        state.unreadVisible === unread
          ? undefined
          : await page.evaluate(`(() => {
          const row = document.querySelector(${JSON.stringify(selector)});
          return {
            unreadPresent: Boolean(row?.querySelector('[data-unread-indicator]')),
            indicatorClass: row?.querySelector('[data-unread-indicator]')?.parentElement?.className,
            focusInRow: Boolean(row?.contains(document.activeElement)),
          };
        })()`);
      expect(
        state,
        JSON.stringify({ errors: page.pageErrors, display }),
      ).toEqual({
        rowVisible: true,
        unreadVisible: unread,
      });
    },
    { timeout: 30_000 },
  ); // 原Task行消费公开未读状态与SSE更新。
}

async function setProjectExpanded(
  { page, host }: UnreadRootContext,
  expanded: boolean,
) {
  const selector = `section[data-project-id="${host.projectId}"] [data-testid="virtual-project-toggle"]`;
  const current = await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')`,
  );
  if (current !== String(expanded))
    await clickOn(page.cdp, page.target.sessionId, { selector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')`,
      ),
    ).toBe(String(expanded)),
  );
}

async function expectProjectUnread(
  { page, host }: UnreadRootContext,
  unread: boolean,
) {
  const selector = `section[data-project-id="${host.projectId}"] [data-testid="virtual-project-unread"]`;
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`,
        ),
        JSON.stringify(page.pageErrors),
      ).toBe(unread),
    { timeout: 30_000 },
  );
}

async function exerciseOriginalUnread(context: UnreadRootContext) {
  const { page, host } = context;
  await markUnreadFromOriginalMenu(context);
  await vi.waitFor(async () =>
    expect(await readUnreadAt(host)).toEqual(expect.any(Number)),
  );
  await expectTaskUnread(context, true);
  await setProjectExpanded(context, false);
  await expectProjectUnread(context, true);
  await setProjectExpanded(context, true);
  await expectTaskUnread(context, true);
  await clickTaskRow(context);
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: 0, y: 0 },
    page.target.sessionId,
  );
  await vi.waitFor(
    async () =>
      expect(
        await readUnreadAt(host),
        JSON.stringify(page.pageErrors),
      ).toBeUndefined(),
    { timeout: 30_000 },
  );
  await expectTaskUnread(context, false);
  await setProjectExpanded(context, false);
  await expectProjectUnread(context, false);
  for (const view of ["timeline", "grouped"] as const) {
    await selectSidebarView(page, view);
    const selected = { ...context, view };
    await markUnreadFromOriginalMenu(selected);
    await vi.waitFor(async () =>
      expect(await readUnreadAt(host)).toEqual(expect.any(Number)),
    );
    await clickTaskRow(selected);
    await vi.waitFor(
      async () => expect(await readUnreadAt(host), view).toBeUndefined(),
      { timeout: 30_000 },
    );
  }
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原ProjectSidebar未读持久接口的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("原菜单标未读显示Task与项目未读点，读取清除且原Task身份、正文和权限保持", async () => {
      await withProjectionResources(async (context) => {
        const { session, model } = context;
        const before = protocol.conversationSnapshotSchema.parse(
          await session.snapshot(),
        );
        const scopeBefore = await readScope(session);
        const modelRequests = model.requests.length;
        expect(before.control.phase).toBe("completedSuccess");
        expect(before.taskControl).toMatchObject({
          projectId: session.projectId,
        });
        expect(scopeBefore).toMatchObject({
          taskId: session.sessionId,
          projectId: session.projectId,
          rootDirectory: session.workspacePath,
        });
        await withUnreadRoot(context, exerciseOriginalUnread);
        const after = protocol.conversationSnapshotSchema.parse(
          await session.snapshot(),
        );
        expect(after.taskControl).toEqual(before.taskControl);
        expect(after.control).toEqual(before.control);
        expect(after.rows).toEqual(before.rows);
        expect(await readScope(session)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(modelRequests);
      });
    }, 180_000); // 已完成真实Task、原菜单未读操作与全部资源关闭期限。
  },
);
