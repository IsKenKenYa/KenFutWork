// @vitest-environment node
import {
  codeProjectTreeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import {
  createTarget,
  type ProjectionContext,
  type ProjectionResources,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const projectViewPreferences = JSON.stringify({
  view: "projects",
  order: [],
  expanded: {},
});
type SessionSurface = {
  taskId: string | null;
  draft: string | null;
  hasCompletedReply: boolean;
};

async function prepareEmptyProject(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { fixture, session } = context;
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  const response = await session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const tree = codeProjectTreeSchema.parse(response.body.result);
  const project = tree.projects.find((entry) => entry.id === targetProjectId);
  if (!project) throw new Error("真实项目树缺少新建项目 B。");
  expect(tree.tasks.filter((task) => task.projectId === project.id)).toEqual(
    [],
  );
  const initial = protocol.conversationSnapshotSchema.parse(
    await session.snapshot(),
  );
  expect(initial.sessionId).toBe(session.sessionId);
  expect(initial.control.phase).toBe("completedSuccess");
  expect(initial.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "assistantText",
      state: "complete",
      text: "正在运行 1",
    }),
  );
  return project;
}

function readSessionSurface(page: OriginalSessionBrowser) {
  return page.evaluate<SessionSurface>(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    return {
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null,
      draft: input?.textContent ?? null,
      hasCompletedReply: document.body.innerText.includes('正在运行 1'),
    };
  })()`);
}

async function waitForOriginalTask(
  page: OriginalSessionBrowser,
  taskId: string,
) {
  await vi.waitFor(
    async () => {
      expect(
        await readSessionSurface(page),
        JSON.stringify(page.pageErrors),
      ).toEqual({
        taskId,
        draft: "",
        hasCompletedReply: true,
      });
    },
    { timeout: 30_000 },
  ); // 实际Task与原消息正文就绪后才检查项目行。
  return readSessionSurface(page);
}

async function expectEmptyProjectRow(
  page: OriginalSessionBrowser,
  project: { id: string; name: string },
  initialSurface: SessionSurface,
) {
  const selector = `section[data-project-id=${JSON.stringify(project.id)}][data-project-host="local"]`;
  await vi.waitFor(
    async () => {
      const rows =
        await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(element => ({
      id: element.getAttribute('data-project-id'),
      host: element.getAttribute('data-project-host'),
      name: element.getAttribute('data-project-name'),
      tasks: element.querySelectorAll('[data-task-id]').length,
    }))`);
      expect(
        rows,
        JSON.stringify({ initialSurface, pageErrors: page.pageErrors }),
      ).toEqual([
        { id: project.id, host: "local", name: project.name, tasks: 0 },
      ]);
    },
    { timeout: 30_000 },
  ); // 只观察原ProjectSidebar的实际section，不建立替代节点。
}

async function assertEmptyProjectVisible(
  context: ProjectionContext,
  resources: ProjectionResources,
  exercise?: (
    page: OriginalSessionBrowser,
    project: { id: string; name: string },
  ) => Promise<void>,
) {
  const { fixture, session, model } = context;
  const project = await prepareEmptyProject(context, resources);
  let browser: OriginalSessionBrowser | undefined;
  const failures: unknown[] = [];
  try {
    browser = await openOriginalSessionBrowser({
      backendBaseUrl: fixture.baseUrl,
      backendOrigin: fixture.origin,
      accessToken: await fixture.app.kernel
        .get("localAccess")
        .getDesktopToken(),
      workspacePath: session.workspacePath,
      projectId: session.projectId,
      sessionId: session.sessionId,
      clientId: session.clientId,
      workspaceShell: true,
      beforeNavigate: async ({ cdp, target }) => {
        await cdp.send(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(projectViewPreferences)});`,
          },
          target.sessionId,
        );
      },
    });
    const initialSurface = await waitForOriginalTask(
      browser,
      session.sessionId,
    );
    expect(model.requests).toHaveLength(1);
    await expectEmptyProjectRow(browser, project, initialSurface);
    expect(await readSessionSurface(browser)).toEqual(initialSurface);
    expect(model.requests).toHaveLength(1);
    await exercise?.(browser, project);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "原项目侧栏验证或浏览器关闭失败", {
      cause: failures[0],
    });
}

async function visiblePoint(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(async () => {
    const result = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || !element.checkVisibility()) return null;
      element.scrollIntoView({ block: "nearest", behavior: "instant" });
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 3, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && element.contains(hit) ? { x, y } : null;
    })()`);
    expect(result, JSON.stringify(page.pageErrors)).not.toBeNull();
    return result;
  });
  if (!point) throw new Error("原项目拖动入口未显示。");
  return point;
}

async function dragTaskToProject(
  page: OriginalSessionBrowser,
  taskId: string,
  projectId: string,
) {
  expect(
    await page.evaluate(
      `document.querySelector('[data-testid="task-item-${taskId}"]')?.draggable`,
    ),
  ).toBe(true);
  const source = await visiblePoint(
    page,
    `[data-testid="task-item-${taskId}"]`,
  );
  const target = await visiblePoint(
    page,
    `section[data-project-id="${projectId}"] [data-testid="virtual-project-row"]`,
  );
  let dragData: unknown;
  const release = page.cdp.on("Input.dragIntercepted", (params, sessionId) => {
    if (sessionId === page.target.sessionId) dragData = params.data;
  });
  await page.cdp.send(
    "Input.setInterceptDrags",
    { enabled: true },
    page.target.sessionId,
  );
  try {
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...source },
      page.target.sessionId,
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
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: source.x + 18,
        y: source.y,
        button: "left",
        buttons: 1,
      },
      page.target.sessionId,
    );
    await page.evaluate("new Promise(requestAnimationFrame)");
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        ...target,
        button: "left",
        buttons: 1,
      },
      page.target.sessionId,
    );
    await vi.waitFor(() =>
      expect(dragData, "原任务行必须提供浏览器拖动内容").toBeTruthy(),
    );
    for (const type of ["dragEnter", "dragOver", "drop"])
      await page.cdp.send(
        "Input.dispatchDragEvent",
        { type, ...target, data: dragData },
        page.target.sessionId,
      );
  } finally {
    release();
    await page.cdp.send(
      "Input.setInterceptDrags",
      { enabled: false },
      page.target.sessionId,
    );
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
}

async function readTree(context: ProjectionContext) {
  const response = await context.session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function exerciseDirectoryConfirmation(
  context: ProjectionContext,
  page: OriginalSessionBrowser,
  project: { id: string },
) {
  const { session, model } = context;
  const initial = (await readTree(context)).tasks.find(
    (task) => task.taskId === session.sessionId,
  );
  expect(initial?.projectId).toBe(session.projectId);
  if (!initial?.taskControl) throw new Error("原Task缺少可信控制观察值。");
  await dragTaskToProject(page, session.sessionId, project.id);
  const confirmation = '[data-testid="confirm-dialog-confirm"]';
  await visiblePoint(page, confirmation);
  expect(
    (await readTree(context)).tasks.find(
      (task) => task.taskId === session.sessionId,
    ),
  ).toEqual(initial);
  // Escape 取消原确认框，不发送补充目录命令。
  for (const type of ["keyDown", "keyUp"])
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      page.target.sessionId,
    );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[role=dialog][data-state=open]") !== null',
      ),
    ).toBe(false),
  );
  expect(
    (await readTree(context)).tasks.find(
      (task) => task.taskId === session.sessionId,
    ),
  ).toEqual(initial);
  await dragTaskToProject(page, session.sessionId, project.id);
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, confirmation),
  );
  await vi.waitFor(
    async () => {
      const rows = await page.evaluate<string[]>(
        `Array.from(document.querySelectorAll('section[data-project-id="${project.id}"] [data-testid="task-item-${session.sessionId}"]')).map(node => node.getAttribute('data-testid'))`,
      );
      expect(rows, JSON.stringify(page.pageErrors)).toEqual([
        `task-item-${session.sessionId}`,
      ]);
    },
    { timeout: 30_000 },
  );
  const moved = await readTree(context);
  expect(
    moved.tasks.find((task) => task.taskId === session.sessionId),
  ).toMatchObject({
    projectId: project.id,
    workspacePath: session.workspacePath,
    taskControl: {
      projectId: project.id,
      branchGeneration: initial.taskControl.branchGeneration + 1,
    },
  });
  expect(
    moved.projects.find((entry) => entry.id === project.id)?.roots,
  ).toContainEqual({
    rootPath: session.workspacePath,
    access: "read-write",
    isPrimary: false,
    position: 1,
  });
  expect(model.requests).toHaveLength(1);
}

async function exerciseStaleConfirmation(
  context: ProjectionContext,
  page: OriginalSessionBrowser,
  project: { id: string },
) {
  const { session, model } = context;
  const before = (await readTree(context)).tasks.find(
    (task) => task.taskId === session.sessionId,
  );
  await dragTaskToProject(page, session.sessionId, project.id);
  const confirmation = '[data-testid="confirm-dialog-confirm"]';
  await visiblePoint(page, confirmation);
  const sent = await session.command("sendText", {
    text: "目录确认期间明确发送的后来输入",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  }); // 等待真实第二轮模型HTTP接纳，不以默认1秒限制运行启动。
  model.finish(1);
  await vi.waitFor(
    async () => {
      expect(
        protocol.conversationSnapshotSchema.parse(await session.snapshot())
          .control.phase,
      ).toBe("completedSuccess");
    },
    { timeout: 30_000 },
  );
  const updated = (await readTree(context)).tasks.find(
    (task) => task.taskId === session.sessionId,
  );
  expect(updated?.conversationRevision).toBeGreaterThan(
    before?.conversationRevision ?? -1,
  );
  const errorsBefore = page.pageErrors.length;
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, confirmation),
  );
  await vi.waitFor(
    () => {
      expect(page.pageErrors.slice(errorsBefore)).toContainEqual(
        expect.objectContaining({
          service: "project",
          method: "moveTask",
          status: 409,
        }),
      );
    },
    { timeout: 10_000 },
  );
  const tree = await readTree(context);
  expect(tree.tasks.find((task) => task.taskId === session.sessionId)).toEqual(
    updated,
  );
  expect(tree.tasks.filter((task) => task.projectId === project.id)).toEqual(
    [],
  );
  expect(
    tree.projects.find((entry) => entry.id === project.id)?.roots,
  ).toHaveLength(1);
  expect(model.requests).toHaveLength(2);
}

async function exerciseSidebarRail(page: OriginalSessionBrowser) {
  const initial = await readSessionSurface(page);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="sidebar-list-title"]',
  });
  const modifiers = await page.evaluate<number>(
    'navigator.platform.includes("Mac") ? 4 : 2',
  );
  for (const type of ["keyDown", "keyUp"])
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers },
      page.target.sessionId,
    );
  await visiblePoint(page, '[aria-label="展开侧栏"]');
  const labels = await page.evaluate<
    string[]
  >(`Array.from(document.querySelectorAll('[data-testid="sidebar"] button'))
    .filter(button => button.checkVisibility()).map(button => button.getAttribute('aria-label'))`);
  for (const label of ["新建任务", "插件市场", "技能", "MCP 服务器"])
    expect(labels).toContain(label);
  expect(await readSessionSurface(page)).toEqual(initial);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[aria-label="展开侧栏"]',
  });
  await visiblePoint(page, '[data-testid="sidebar-view-menu"]');
  expect(await readSessionSurface(page)).toEqual(initial);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原ProjectSidebar的生产Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("项目视图显示真实名称的空项目 B，同时保留已完成Task A与原草稿", async () => {
      await withProjectionResources(assertEmptyProjectVisible);
    }, 180_000); // 原生产Root构建、独占浏览器、真实HTTP/SSE/PG与全部资源关闭期限。
    it("原Task拖动取消时保持项目，明确补充目录后移动并保留固定工作目录", async () => {
      await withProjectionResources((context, resources) =>
        assertEmptyProjectVisible(context, resources, (page, project) =>
          exerciseDirectoryConfirmation(context, page, project),
        ),
      );
    }, 180_000); // 浏览器实际拖动、原确认框与实际移动事务的完整期限。
    it("目录确认期间的新输入推进修订，旧拖动拒绝且不补充目录", async () => {
      await withProjectionResources((context, resources) =>
        assertEmptyProjectVisible(context, resources, (page, project) =>
          exerciseStaleConfirmation(context, page, project),
        ),
      );
    }, 180_000); // 原确认框等待、真实第二轮模型HTTP与旧观察拒绝期限。
    it("收起侧栏仍提供新建、插件、技能和MCP入口，重新展开保持原会话", async () => {
      await withProjectionResources((context, resources) =>
        assertEmptyProjectVisible(context, resources, exerciseSidebarRail),
      );
    }, 180_000); // 原生产Root、真实服务和浏览器收起／展开交互期限。
  },
);
