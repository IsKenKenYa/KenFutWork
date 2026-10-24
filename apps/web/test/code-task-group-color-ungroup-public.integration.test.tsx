// @vitest-environment node
import {
  codeProjectTreeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  pressKey,
} from "../../server/src/features/browser/cdp-client.js";
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

async function readTree({ host }: TaskGroupPublicPageContext) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function putExistingTaskInGroup(
  context: TaskGroupPublicPageContext,
  groupId: string,
) {
  const tree = await readTree(context);
  const task = tree.tasks.find(
    (entry) => entry.taskId === context.host.sessionId,
  );
  if (!task?.workspaceIdentity)
    throw new Error("颜色与取消组验收缺少已有历史的真实 Task。");
  const before = await readGroups(context.host);
  const moved = await context.host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "move",
    args: [
      {
        node: {
          type: "task",
          task: {
            hostId: task.hostId,
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            taskId: task.taskId,
          },
        },
        sourceGroupId:
          before.members.find((member) => member.taskId === task.taskId)
            ?.groupId ?? null,
        groupId,
        expectedRevision: before.revision,
      },
    ],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const structure = await readGroups(context.host);
  expect(structure.members).toEqual([
    {
      groupId,
      workspaceKey: task.workspaceIdentity,
      taskId: task.taskId,
      sortOrder: 0,
    },
  ]);
  const selector = `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid=${JSON.stringify(`task-item-${task.taskId}`)}]`;
  await vi.waitFor(async () =>
    expect(
      await context.page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`,
      ),
      JSON.stringify(context.page.pageErrors),
    ).toBe(true),
  );
  return { task, tree, structure };
}

async function visiblePoint(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.closest('[inert], [hidden], [aria-hidden="true"]')) return null;
        element.scrollIntoView({ block: "center" });
        await new Promise(requestAnimationFrame);
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return element.checkVisibility() && hit && element.contains(hit) ? { x, y } : null;
      })()`,
    );
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原分组操作入口尚未显示。");
  return point;
}

async function selectBlueColor(page: OriginalSessionBrowser, groupId: string) {
  const trigger = `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid="task-group-color-trigger"]`;
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, trigger),
  );
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, '[data-testid="task-group-color-blue"]'),
  );
}

async function expectBlueSelection(
  page: OriginalSessionBrowser,
  groupId: string,
) {
  const trigger = `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid="task-group-color-trigger"]`;
  await pressKey(page.cdp, page.target.sessionId, "Escape");
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, trigger),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=task-group-color-blue]")?.getAttribute("aria-checked")',
      ),
      JSON.stringify(page.pageErrors),
    ).toBe("true"),
  );
  await pressKey(page.cdp, page.target.sessionId, "Escape");
}

async function ungroupFromOriginalMenu(
  page: OriginalSessionBrowser,
  groupId: string,
) {
  const header = `[data-grouped-group-header-id=${JSON.stringify(groupId)}]`;
  const point = await visiblePoint(page, header);
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, '[data-testid="task-group-ungroup"]'),
  );
}

async function expectTaskAtRoot(
  { page, host }: TaskGroupPublicPageContext,
  groupId: string,
) {
  const taskSelector = `[data-testid="task-grouped-view"] [data-testid=${JSON.stringify(`task-item-${host.sessionId}`)}]`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
    const tasks = document.querySelectorAll(${JSON.stringify(taskSelector)});
    const task = tasks[0];
    return {
      remainingGroups: document.querySelectorAll('[data-task-group-id=${JSON.stringify(groupId)}]').length,
      taskCount: tasks.length,
      visible: Boolean(task?.checkVisibility()),
      atRoot: Boolean(task && !task.closest('[data-task-group-id]')),
    };
  })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      remainingGroups: 0,
      taskCount: 1,
      visible: true,
      atRoot: true,
    }),
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组选色与取消组的Root、HTTP、SSE和PostgreSQL integration",
  () => {
    it("原颜色菜单保存蓝色并取消分组，Task回到根层且当前草稿文件与权限保持", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const {
            page,
            host,
            scopeBefore,
            snapshotBefore,
            model,
            modelRequestCountBefore,
          } = context;
          const group = await createGroupFromUi(context);
          await dismissGroupSetup(page);
          const { task, tree, structure } = await putExistingTaskInGroup(
            context,
            group.id,
          );
          await expectContentPreserved(context);
          expect(group.color).not.toBe("blue");
          await selectBlueColor(page, group.id);
          const colored = await vi.waitFor(async () => {
            const current = await readGroups(host);
            expect(current.revision).toBe(structure.revision + 1);
            expect(current.groups).toEqual([
              expect.objectContaining({
                ...group,
                color: "blue",
                updatedAt: expect.any(Number),
              }),
            ]);
            expect(current.members).toEqual(structure.members);
            expect(current.order).toEqual(structure.order);
            return current;
          });
          await expectBlueSelection(page, group.id);
          await expectContentPreserved(context);
          await ungroupFromOriginalMenu(page, group.id);
          await vi.waitFor(async () =>
            expect(await readGroups(host)).toEqual({
              revision: colored.revision + 1,
              groups: [],
              members: [],
              order: [
                {
                  type: "task",
                  key: JSON.stringify([task.workspaceIdentity, task.taskId]),
                  sortOrder: 0,
                },
              ],
            }),
          );
          await expectTaskAtRoot(context, group.id);
          await expectContentPreserved(context);
          expect((await readTree(context)).tasks).toEqual(tree.tasks);
          expect(await readScope(host)).toEqual(scopeBefore);
          const original = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          expect(original.rows.window).toEqual(snapshotBefore.rows.window);
          expect(original.taskControl).toEqual(snapshotBefore.taskControl);
          expect(model.requests).toHaveLength(modelRequestCountBefore);
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原颜色与取消组菜单、真实HTTP/SSE、独占浏览器和临时PG关闭期限。
  },
);
