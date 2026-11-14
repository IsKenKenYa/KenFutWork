// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  type CodeTaskGroupMove,
  codeProjectTreeSchema,
  codeTaskGroupMoveArgsSchema,
  codeTaskGroupSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  expectContentPreserved,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

type MoveRequest = { requestId: string; input: CodeTaskGroupMove };

async function readTree({ host }: TaskGroupPublicPageContext) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function prepareGroups(context: TaskGroupPublicPageContext) {
  const { host } = context;
  const tree = await readTree(context);
  const task = tree.tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task?.workspaceIdentity)
    throw new Error("菜单与拖放验收缺少已有历史的真实 Task。");
  const reference = {
    hostId: task.hostId,
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  const admitted = await host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "admit",
    args: [{ tasks: [reference] }],
  });
  expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
  const groups = [];
  for (const title of ["分组 B", "分组 C"]) {
    const observed = await readGroups(host);
    const saved = await host.client.request("/api/code-ui/rpc", {
      service: "task-groups",
      method: "save",
      args: [
        {
          creationId: randomUUID(),
          expectedRevision: observed.revision,
          title,
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    groups.push(codeTaskGroupSchema.parse(saved.body.result));
  }
  const [groupB, groupC] = groups;
  if (!groupB || !groupC) throw new Error("原菜单与拖放缺少两个目标分组。");
  const structure = await readGroups(host);
  expect(structure.members).toEqual([]);
  expect(structure.order).toEqual([
    { type: "group", key: groupC.id, sortOrder: 0 },
    { type: "group", key: groupB.id, sortOrder: 1 },
    {
      type: "task",
      key: JSON.stringify([task.workspaceIdentity, task.taskId]),
      sortOrder: 2,
    },
  ]);
  return { task, reference, tree, groupB, groupC, structure };
}

function observeMoves(page: OriginalSessionBrowser) {
  const requests: MoveRequest[] = [];
  const completed = new Set<string>();
  const statuses = new Map<string, number>();
  const errors: unknown[] = [];
  const offRequest = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      try {
        const request = z
          .object({ url: z.string(), postData: z.string().optional() })
          .parse(params.request);
        if (
          new URL(request.url).pathname !== "/api/code-ui/rpc" ||
          !request.postData
        )
          return;
        const rpc = z
          .object({
            service: z.string(),
            method: z.string(),
            args: z.array(z.unknown()),
          })
          .parse(JSON.parse(request.postData));
        if (rpc.service === "task-groups" && rpc.method === "move")
          requests.push({
            requestId: params.requestId,
            input: codeTaskGroupMoveArgsSchema.parse(rpc.args)[0],
          });
      } catch (error) {
        errors.push(error);
      }
    },
  );
  const offStatus = page.cdp.on(
    "Network.responseReceived",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      ) {
        const response = z
          .object({ status: z.number() })
          .parse(params.response);
        statuses.set(params.requestId, response.status);
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
  return {
    requests,
    async expectMove(index: number, expected: CodeTaskGroupMove) {
      const request = await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(requests).toHaveLength(index + 1);
        const current = requests[index];
        if (!current) throw new Error("原菜单或拖放尚未发出移动请求。");
        expect(current.input).toEqual(expected);
        expect(statuses.get(current.requestId)).toBe(200);
        expect(completed.has(current.requestId)).toBe(true);
        return current;
      });
      const response = z
        .object({ body: z.string(), base64Encoded: z.boolean().optional() })
        .parse(
          await page.cdp.send(
            "Network.getResponseBody",
            { requestId: request.requestId },
            page.target.sessionId,
          ),
        );
      expect(
        JSON.parse(
          response.base64Encoded
            ? Buffer.from(response.body, "base64").toString("utf8")
            : response.body,
        ),
      ).toEqual({ result: null });
    },
    dispose() {
      offRequest();
      offStatus();
      offCompleted();
    },
  };
}

function taskSelector(taskId: string) {
  return `[data-testid="task-grouped-view"] [data-testid=${JSON.stringify(`task-item-${taskId}`)}]`;
}

async function visiblePoint(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.closest('[inert], [hidden], [aria-hidden="true"]')) return null;
      element.scrollIntoView({ block: "center" });
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 3;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return element.checkVisibility() && hit && element.contains(hit) ? { x, y } : null;
    })()`);
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原菜单或拖放入口尚未显示。");
  return point;
}

async function moveByTaskMenu(
  page: OriginalSessionBrowser,
  taskId: string,
  groupId: string,
) {
  const source = await visiblePoint(page, taskSelector(taskId));
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...source },
    page.target.sessionId,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type,
        ...source,
        button: "right",
        clickCount: 1,
      },
      page.target.sessionId,
    );
  const submenu = await visiblePoint(
    page,
    '[data-testid="task-group-move-menu"]',
  );
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...submenu },
    page.target.sessionId,
  );
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(
      page,
      `[data-task-group-target=${JSON.stringify(groupId)}]`,
    ),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Array.from(document.querySelectorAll('[role="menu"]')).filter(element => element.checkVisibility()).length`,
      ),
    ).toBe(0),
  );
}

async function expectTaskGroup(
  context: TaskGroupPublicPageContext,
  taskId: string,
  groupId: string,
) {
  const { page } = context;
  let lastObservation: unknown;
  try {
    await vi.waitFor(
      async () => {
        const observation = await taskGroupDomObservation(page, taskId);
        lastObservation = observation;
        expect(observation.current, JSON.stringify(observation)).toEqual({
          groupId,
          visible: true,
        });
      },
      { timeout: 5_000 },
    ); // 等待真实SSE与当前原分组视图同步。
  } catch (cause) {
    const tree = await readTree(context);
    throw new Error(
      JSON.stringify({
        taskId,
        expectedGroupId: groupId,
        lastObservation,
        taskStillPublic: tree.tasks.some((task) => task.taskId === taskId),
        publicTasks: tree.tasks,
        pageErrors: page.pageErrors,
      }),
      { cause },
    );
  }
}

async function taskGroupDomObservation(
  page: OriginalSessionBrowser,
  taskId: string,
) {
  return page.evaluate<{
    current: { groupId: string | null; visible: boolean };
    diagnostics: unknown;
  }>(`(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const task = document.querySelector(${JSON.stringify(taskSelector(taskId))});
    const groupView = document.querySelector('[data-testid="task-grouped-view"]');
    return {
      current: {
        groupId: task?.closest('[data-task-group-id]')?.getAttribute('data-task-group-id') ?? null,
        visible: Boolean(task?.checkVisibility()),
      },
      diagnostics: {
        points: [task, document.querySelector('[data-grouped-empty-drop-zone-id]')].map(element => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 3, rect.top + rect.height / 2);
          return { rect: rect.toJSON(), hit: hit?.outerHTML.slice(0, 600) };
        }),
        groupViewPresent: Boolean(groupView),
        groupViewHidden: Boolean(groupView?.closest('[hidden], [inert], [aria-hidden="true"]')),
        tabs: Array.from(sidebar?.querySelectorAll('[role="tab"]') ?? []).map(element => ({
          text: element.textContent, state: element.getAttribute('data-state'),
          selected: element.getAttribute('aria-selected'), visible: element.checkVisibility(),
        })),
        groups: Array.from(sidebar?.querySelectorAll('[data-task-group-id]') ?? []).map(element => {
          const header = element.querySelector('[data-grouped-group-header-id]');
          const content = element.querySelector('[data-grouped-group-content-id]');
          return {
            id: element.getAttribute('data-task-group-id'),
            title: element.getAttribute('data-task-group-title'),
            collapsed: element.getAttribute('data-group-collapsed'),
            expanded: header?.getAttribute('aria-expanded'),
            count: header?.querySelector(':scope > span')?.textContent,
            contentText: content?.textContent,
            contentHidden: content?.getAttribute('aria-hidden'),
          };
        }),
        rows: Array.from(sidebar?.querySelectorAll('[data-task-item-key]') ?? []).map(element => ({
          testId: element.getAttribute('data-testid'),
          key: element.getAttribute('data-task-item-key'),
          groupId: element.closest('[data-task-group-id]')?.getAttribute('data-task-group-id'),
          text: element.textContent, visible: element.checkVisibility(),
          hidden: Boolean(element.closest('[hidden], [inert], [aria-hidden="true"]')),
          height: element.getBoundingClientRect().height,
        })),
        sidebarText: sidebar?.textContent,
        bodyCursor: document.body.style.cursor,
        menus: Array.from(document.querySelectorAll('[role="menu"]'))
          .filter(element => element.checkVisibility()).map(element => element.textContent),
      },
    };
  })()`);
}

async function measureDragLayout(
  page: OriginalSessionBrowser,
  taskId: string,
  groupId: string,
) {
  const measured = await vi.waitFor(
    async () => {
      const points = await page.evaluate<{
        source: { x: number; y: number };
        target: { x: number; y: number };
        sourceGroupId: string;
      } | null>(`(async () => {
      const source = document.querySelector(${JSON.stringify(taskSelector(taskId))});
      const target = document.querySelector('[data-grouped-empty-drop-zone-id=${JSON.stringify(groupId)}]');
      if (!source || !target) return null;
      source.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      target.closest('[data-grouped-group-item-id]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(requestAnimationFrame);
      const rects = [source, target].map(element => element.getBoundingClientRect());
      await new Promise(requestAnimationFrame);
      const next = [source, target].map(element => element.getBoundingClientRect());
      const stable = rects.every((rect, index) =>
        ['left', 'top', 'width', 'height'].every(key => rect[key] === next[index][key]));
      if (!stable || !source.isConnected || !target.isConnected) return null;
      const start = { x: next[0].left + next[0].width / 3, y: next[0].top + next[0].height / 2 };
      const end = { x: next[1].left + next[1].width / 3, y: next[1].top + next[1].height / 2 };
      const sourceHit = document.elementFromPoint(start.x, start.y);
      const targetHit = document.elementFromPoint(end.x, end.y);
      const sourceGroupId = source.closest('[data-task-group-id]')?.getAttribute('data-task-group-id');
      if (!sourceGroupId || sourceHit?.closest('[data-task-item-key]') !== source ||
          sourceHit.closest('button') || !targetHit || !target.contains(targetHit)) return null;
      return { source: start, target: end, sourceGroupId };
    })()`);
      expect(
        points,
        JSON.stringify(await taskGroupDomObservation(page, taskId)),
      ).not.toBeNull();
      return points;
    },
    { timeout: 5_000 },
  ); // 同一布局帧测量两端，并等待两帧真实位置保持。
  if (!measured) throw new Error("原 Task 与目标组尚未处于稳定布局。");
  return measured;
}

async function expectTaskDragActive(
  page: OriginalSessionBrowser,
  taskId: string,
  sourceGroupId: string,
) {
  await vi.waitFor(
    async () => {
      const observation = await page.evaluate(`(() => {
      const announcements = Array.from(document.querySelectorAll('[id^="DndLiveRegion-"]'))
        .map(element => element.textContent ?? '');
      const sourceGroup = document.querySelector('[data-task-group-id=${JSON.stringify(sourceGroupId)}]');
      return {
        cursor: document.body.style.cursor,
        taskAnnounced: announcements.some(text => text.includes(${JSON.stringify(taskId)})),
        groupAnnounced: announcements.some(text => text.includes('Picked up draggable item group:')),
        collapsed: sourceGroup?.getAttribute('data-group-collapsed'),
        announcements,
      };
    })()`);
      expect(
        observation,
        JSON.stringify({ observation, errors: page.pageErrors }),
      ).toMatchObject({
        cursor: "grabbing",
        taskAnnounced: true,
        groupAnnounced: false,
        collapsed: "false",
      });
    },
    { timeout: 5_000 },
  ); // 原Dnd可访问性公告必须包含本次Task身份，来源组保持展开。
}

async function dragTaskToEmptyGroup(
  context: TaskGroupPublicPageContext,
  taskId: string,
  groupId: string,
  moves: ReturnType<typeof observeMoves>,
) {
  const { page } = context;
  const initial = await measureDragLayout(page, taskId, groupId);
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...initial.source },
    page.target.sessionId,
  );
  // 悬停可能显示行内按钮；按下前重新同时测量，并核对指针仍命中真实 Task 行。
  const { source, target, sourceGroupId } = await measureDragLayout(
    page,
    taskId,
    groupId,
  );
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      ...source,
      button: "left",
      buttons: 1,
      clickCount: 1,
    },
    page.target.sessionId,
  );
  try {
    // 实际鼠标先越过原 PointerSensor 的激活距离，再逐步移动到空组。
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: source.x + 12,
        y: source.y,
        button: "left",
        buttons: 1,
      },
      page.target.sessionId,
    );
    await expectTaskDragActive(page, taskId, sourceGroupId);
    // 八步只控制本次浏览器鼠标手势的采样，不属于产品治理数值。
    for (let step = 1; step <= 8; step += 1) {
      await page.cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          button: "left",
          buttons: 1,
          x: source.x + 12 + ((target.x - source.x - 12) * step) / 8,
          y: source.y + ((target.y - source.y) * step) / 8,
        },
        page.target.sessionId,
      );
      await page.evaluate("new Promise(requestAnimationFrame)");
    }
    await expectTaskGroup(context, taskId, groupId);
    expect(moves.requests).toHaveLength(1);
  } finally {
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        ...target,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      page.target.sessionId,
    );
  }
  await vi.waitFor(async () =>
    expect(await page.evaluate("document.body.style.cursor")).not.toBe(
      "grabbing",
    ),
  );
}

async function expectOrganizedTask(
  context: TaskGroupPublicPageContext,
  structure: Awaited<ReturnType<typeof readGroups>>,
  groupId: string,
  revision: number,
  workspaceKey: string,
) {
  return vi.waitFor(async () => {
    const current = await readGroups(context.host);
    expect(current.revision).toBe(revision);
    expect(current.groups).toEqual(structure.groups);
    expect(current.members).toEqual([
      {
        groupId,
        workspaceKey,
        taskId: context.host.sessionId,
        sortOrder: 0,
      },
    ]);
    expect(current.order).toEqual(
      structure.order
        .filter((node) => node.type === "group")
        .map((node, sortOrder) => ({ ...node, sortOrder })),
    );
    return current;
  });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原任务菜单与指针拖放的Root、HTTP、SSE和PostgreSQL integration",
  () => {
    it("原菜单移动到B再鼠标拖到C，每次使用观察修订且保留Task内容与权限", async () => {
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
          const { task, reference, tree, groupB, groupC, structure } =
            await prepareGroups(context);
          await visiblePoint(
            page,
            `[data-grouped-group-header-id=${JSON.stringify(groupC.id)}]`,
          );
          const moves = observeMoves(page);
          try {
            await moveByTaskMenu(page, task.taskId, groupB.id);
            await moves.expectMove(0, {
              node: { type: "task", task: reference },
              sourceGroupId: null,
              groupId: groupB.id,
              expectedRevision: structure.revision,
            });
            const moved = await expectOrganizedTask(
              context,
              structure,
              groupB.id,
              structure.revision + 1,
              reference.workspaceIdentity,
            );
            await expectTaskGroup(context, task.taskId, groupB.id);
            await expectContentPreserved(context);
            await dragTaskToEmptyGroup(context, task.taskId, groupC.id, moves);
            await moves.expectMove(1, {
              node: { type: "task", task: reference },
              sourceGroupId: groupB.id,
              groupId: groupC.id,
              expectedRevision: moved.revision,
            });
            await expectOrganizedTask(
              context,
              structure,
              groupC.id,
              moved.revision + 1,
              reference.workspaceIdentity,
            );
            await expectTaskGroup(context, task.taskId, groupC.id);
            await expectContentPreserved(context);
            expect(moves.requests).toHaveLength(2);
            expect((await readTree(context)).tasks).toEqual(tree.tasks);
            expect(await readScope(host)).toEqual(scopeBefore);
            const original = protocol.conversationSnapshotSchema.parse(
              await host.snapshot(),
            );
            expect(original.rows.window).toEqual(snapshotBefore.rows.window);
            expect(original.taskControl).toEqual(snapshotBefore.taskControl);
            expect(model.requests).toHaveLength(modelRequestCountBefore);
          } finally {
            moves.dispose();
          }
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原菜单、真实CDP指针手势、HTTP/SSE与独占临时PG完整关闭期限。
  },
);
