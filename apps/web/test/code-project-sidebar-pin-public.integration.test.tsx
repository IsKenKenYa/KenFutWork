// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskPinInput,
  codeProjectTreeSchema,
  codeTaskPinArgsSchema,
  codeTaskPinControllerArgsSchema,
  codeTaskPinMetaSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { TID_WORKSPACE_HEADER, TID_WORKSPACE_MORE_BUTTON } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  expectContentPreserved,
  readScope,
  type TaskGroupPublicPageContext,
} from "./setup/code-task-groups-public.fixture.js";
import {
  type ProjectionContext,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

type Host = ProjectionContext["session"];
const inputSelector = '[role="textbox"][contenteditable="true"]';
const requestFactSchema = z.object({
  requestId: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  state: z.string(),
  error: z.string().optional(),
});

async function visiblePoint(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(
    async () => {
      const found = await page.evaluate<{ x: number; y: number } | null>(
        `(async () => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element?.checkVisibility()) return null;
          element.scrollIntoView({ block: 'center' });
          const first = element.getBoundingClientRect();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const rect = element.getBoundingClientRect();
          if (first.x !== rect.x || first.y !== rect.y || first.width !== rect.width || first.height !== rect.height)
            return null;
          const point = { x: rect.left + rect.width / 3, y: rect.top + rect.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          return hit && element.contains(hit) ? point : null;
        })()`,
      );
      expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
      return found;
    },
    { timeout: 30_000 },
  ); // 原布局与滚动结束后核对真实命中位置。
  if (!point) throw new Error("原置顶操作入口尚未显示。");
  return point;
}

function taskRow(host: Host, pinned: boolean) {
  const owner = pinned
    ? '[data-testid="project-pinned-tasks"]'
    : `section[data-project-id=${JSON.stringify(host.projectId)}]`;
  return `${owner} [data-testid=${JSON.stringify(`task-item-${host.sessionId}`)}]`;
}

async function openPinMenu(
  { page, host }: TaskGroupPublicPageContext,
  pinned: boolean,
) {
  const selector = taskRow(host, pinned);
  const point = await visiblePoint(page, selector);
  expect(
    await page.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      const hit = document.elementFromPoint(${point.x}, ${point.y});
      return Boolean(row && hit && row.contains(hit) && !hit.closest('button'));
    })()`),
    JSON.stringify(page.pageErrors),
  ).toBe(true);
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
  await focusPinMenuItem(page, pinned);
}

async function focusPinMenuItem(page: OriginalSessionBrowser, pinned: boolean) {
  const label = pinned ? "取消置顶任务" : "置顶任务";
  const action = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(() => {
        const item = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
          .find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(label)});
        if (!item || item.getAttribute('aria-disabled') === 'true') return null;
        const rect = item.getBoundingClientRect();
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        return hit && item.contains(hit) ? point : null;
      })()`,
    );
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!action) throw new Error("原任务置顶菜单项尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...action },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.activeElement?.textContent?.trim()"),
    ).toBe(label),
  );
}

async function activatePinAndReadResponse(
  { page, host, snapshotBefore }: TaskGroupPublicPageContext,
  pinned: boolean,
) {
  const previous = new Set(
    z
      .array(requestFactSchema)
      .parse(page.requests)
      .map((entry) => entry.requestId),
  );
  await pressKey(page.cdp, page.target.sessionId, "Enter");
  const response = await vi.waitFor(
    () => {
      const finished = z
        .array(requestFactSchema)
        .parse(page.requests)
        .filter(
          (entry) =>
            !previous.has(entry.requestId) &&
            ((entry.service === "window-controller" &&
              entry.method === "mutateTask") ||
              (entry.service === "zcode-task" &&
                entry.method === "setTaskPinned")) &&
            (entry.state === "finished" || entry.state === "failed"),
        );
      expect(finished, JSON.stringify(page.pageErrors)).toHaveLength(1);
      const current = finished[0];
      if (!current) throw new Error("原置顶菜单尚未取得 HTTP 回执。");
      return current;
    },
    { timeout: 5_000 },
  ); // 只等实际请求结束，HTTP 400 等错误在下面立即报告，不等待持久状态超时。
  if (response.state === "failed")
    throw new Error(`原置顶请求传输失败：${JSON.stringify(response)}`);
  const payload = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId: response.requestId },
        page.target.sessionId,
      ),
    );
  const body = JSON.parse(
    payload.base64Encoded
      ? Buffer.from(payload.body, "base64").toString("utf8")
      : payload.body,
  );
  expect(response.status, JSON.stringify({ response, body })).toBe(200);
  const request = z
    .object({ postData: z.string() })
    .parse(
      await page.cdp.send(
        "Network.getRequestPostData",
        { requestId: response.requestId },
        page.target.sessionId,
      ),
    );
  const rpc = z
    .object({ args: z.array(z.unknown()) })
    .parse(JSON.parse(request.postData));
  const target = {
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    taskControl: snapshotBefore.taskControl,
  };
  expect(rpc.args[0]).toMatchObject(
    response.service === "window-controller"
      ? { address: target, mutation: { kind: "pin", pinned } }
      : { ...target, pinned },
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'Array.from(document.querySelectorAll("[role=menu]")).filter(node => node.checkVisibility()).length',
      ),
    ).toBe(0),
  );
  return { response, rpc, body };
}

async function expectPinnedPlacement(
  { page, host }: TaskGroupPublicPageContext,
  pinned: boolean,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("真实项目树缺少置顶操作的原 Task。");
  expect(Boolean(task.pinned)).toBe(pinned);
  expect(task).toMatchObject({
    projectId: host.projectId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
  });
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
          const visibleCount = selector => Array.from(document.querySelectorAll(selector))
            .filter(node => node.checkVisibility()).length;
          return {
            pinned: visibleCount(${JSON.stringify(taskRow(host, true))}),
            project: visibleCount(${JSON.stringify(taskRow(host, false))}),
          };
        })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({ pinned: pinned ? 1 : 0, project: pinned ? 0 : 1 }),
    { timeout: 5_000 },
  ); // 持久结果确认后等待原项目树与置顶分区实际更新。
  return task;
}

async function openHeaderPinMenu(
  { page, host }: TaskGroupPublicPageContext,
  pinned: boolean,
) {
  const selector = `[data-testid=${JSON.stringify(TID_WORKSPACE_HEADER)}] [data-testid=${JSON.stringify(TID_WORKSPACE_MORE_BUTTON)}]`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const buttons = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const visible = buttons.filter(button => button.checkVisibility());
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        return {
          visibleButtons: visible.length,
          disabled: visible[0]?.disabled,
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ visibleButtons: 1, disabled: false, taskId: host.sessionId }),
  );
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, selector),
  );
  await focusPinMenuItem(page, pinned);
}

async function readPublicPinMeta(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskPinMetaSchema.parse(response.body.result);
}

async function exerciseHeaderPin(context: TaskGroupPublicPageContext) {
  let current = await readPublicPinMeta(context.host);
  expect(current.pinned).toBe(false);
  await expectPinnedPlacement(context, false);
  for (const pinned of [true, false]) {
    await openHeaderPinMenu(context, !pinned);
    const { response, rpc, body } = await activatePinAndReadResponse(
      context,
      pinned,
    );
    expect(response).toMatchObject({
      service: "zcode-task",
      method: "setTaskPinned",
      status: 200,
    });
    expect(codeTaskPinArgsSchema.parse(rpc.args)[0]).toEqual({
      taskId: current.taskId,
      workspacePath: current.workspacePath,
      workspaceIdentity: current.workspaceIdentity,
      taskControl: current.taskControl,
      observedPinRevision: current.pinRevision,
      pinned,
    });
    const result = codeTaskPinMetaSchema.parse(
      z.object({ result: z.unknown() }).parse(body).result,
    );
    expect(result).toMatchObject({
      taskId: context.host.sessionId,
      pinned,
      pinRevision: current.pinRevision + 1,
      taskControl: current.taskControl,
    });
    current = await readPublicPinMeta(context.host);
    expect(current).toEqual(result);
    const task = await expectPinnedPlacement(context, pinned);
    expect(task.pinRevision).toBe(result.pinRevision);
    expect(task.taskControl).toEqual(result.taskControl);
    await expectContentPreserved(context);
    expect(
      protocol.conversationSnapshotSchema.parse(await context.host.snapshot()),
    ).toEqual(context.snapshotBefore);
    expect(await readScope(context.host)).toEqual(context.scopeBefore);
    expect(context.model.requests).toHaveLength(
      context.modelRequestCountBefore,
    );
  }
}

async function prepareCurrentContent(
  context: ProjectionContext,
  page: OriginalSessionBrowser,
  previewPath: string,
  previewTitle: string,
): Promise<TaskGroupPublicPageContext> {
  const { session: host, model, fixture } = context;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        return {
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          completedReply: document.body.innerText.includes('正在运行 1'),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ taskId: host.sessionId, completedReply: true }),
  );
  const project = `section[data-project-id=${JSON.stringify(host.projectId)}]`;
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      ...(await visiblePoint(
        page,
        `${project} [data-testid="virtual-project-row"]`,
      )),
    },
    page.target.sessionId,
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${project} [data-testid="virtual-project-files"]`,
  });
  const file = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${previewPath}`)}]`;
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, file),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector('[data-side-pane-tab-id][data-state="active"] [data-side-pane-tab-title]')?.textContent`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(previewTitle),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'Boolean(document.querySelector("[data-testid=preview-pane]")?.checkVisibility())',
      ),
    ).toBe(true),
  );
  await clickExactText(
    page,
    '[data-testid="workspace-file-tree-panel"] button',
    "返回任务",
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=workspace-file-tree-panel]")?.checkVisibility()',
      ),
    ).toBe(false),
  );
  const draft = "任务置顶期间保留的草稿";
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  await typeText(page.cdp, page.target.sessionId, draft);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(draft),
  );
  await page.evaluate(`(() => {
    window.__taskGroupPublicBefore = {
      input: document.querySelector(${JSON.stringify(inputSelector)}),
      preview: document.querySelector('[data-testid="preview-pane"]'),
      tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
    };
  })()`);
  return {
    fixture,
    host,
    model,
    page,
    draft,
    previewTitle,
    scopeBefore: await readScope(host),
    snapshotBefore: protocol.conversationSnapshotSchema.parse(
      await host.snapshot(),
    ),
    modelRequestCountBefore: model.requests.length,
  };
}

async function exercisePin(context: TaskGroupPublicPageContext) {
  await expectPinnedPlacement(context, false);
  await expectContentPreserved(context);
  for (const pinned of [true, false, true]) {
    await openPinMenu(context, !pinned);
    await activatePinAndReadResponse(context, pinned);
    await expectPinnedPlacement(context, pinned);
    await expectContentPreserved(context);
    expect(
      protocol.conversationSnapshotSchema.parse(await context.host.snapshot()),
    ).toEqual(context.snapshotBefore);
    expect(await readScope(context.host)).toEqual(context.scopeBefore);
    expect(context.model.requests).toHaveLength(
      context.modelRequestCountBefore,
    );
  }
}

function pinRequest(request: unknown): CodeTaskPinInput | undefined {
  const candidate = z
    .object({ url: z.string(), postData: z.string().optional() })
    .parse(request);
  if (
    new URL(candidate.url).pathname !== "/api/code-ui/rpc" ||
    !candidate.postData
  )
    return undefined;
  const rpc = z
    .object({
      service: z.string(),
      method: z.string(),
      args: z.array(z.unknown()),
    })
    .parse(JSON.parse(candidate.postData));
  if (rpc.service === "zcode-task" && rpc.method === "setTaskPinned")
    return codeTaskPinArgsSchema.parse(rpc.args)[0];
  if (rpc.service !== "window-controller" || rpc.method !== "mutateTask")
    return undefined;
  const parsed = codeTaskPinControllerArgsSchema.safeParse(rpc.args);
  return parsed.success
    ? { ...parsed.data[0].address, pinned: parsed.data[0].mutation.pinned }
    : undefined;
}

async function readResponseBody(
  page: OriginalSessionBrowser,
  method: "Fetch.getResponseBody" | "Network.getResponseBody",
  requestId: string,
) {
  const payload = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(await page.cdp.send(method, { requestId }, page.target.sessionId));
  return payload.base64Encoded
    ? Buffer.from(payload.body, "base64").toString("utf8")
    : payload.body;
}

/** 只暂停本例首个 pin 的真实响应；继续操作不修改状态码、头部或响应字节。 */
async function holdFirstPinResponse(
  page: OriginalSessionBrowser,
  taskId: string,
) {
  type PinResponse = {
    requestId: string;
    networkId: string;
    status: number;
    input: CodeTaskPinInput;
  };
  const pins: PinResponse[] = [];
  const pinRequests = new Map<string, CodeTaskPinInput>();
  const completed = new Set<string>();
  const readsAfterRelease = new Set<string>();
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  let held: PinResponse | undefined;
  let originalBody: string | undefined;
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
      const input = pinRequest(params.request);
      if (input?.taskId === taskId) {
        const response = {
          requestId: params.requestId,
          networkId: z.string().parse(params.networkId),
          status: z.number().parse(params.responseStatusCode),
          input,
        };
        pins.push(response);
        if (!held) {
          held = response;
          return;
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
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      try {
        const input = pinRequest(params.request);
        if (input?.taskId === taskId) pinRequests.set(params.requestId, input);
        if (!released) return;
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
            service: z.string().optional(),
            method: z.string().optional(),
          })
          .parse(JSON.parse(request.postData));
        if (rpc.service === "project" && rpc.method === "readTree")
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
  try {
    await page.cdp.send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: "*/api/code-ui/rpc", requestStage: "Response" },
        ],
      },
      page.target.sessionId,
    );
  } catch (error) {
    offPaused();
    offRequested();
    offCompleted();
    throw error;
  }
  return {
    async waitForHeld() {
      const response = await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(pins).toHaveLength(1);
          if (!held) throw new Error("原置顶请求尚未取得真实响应。");
          return held;
        },
        { timeout: 5_000 },
      ); // 只等响应到达，错误状态在轮询外立即报告。
      originalBody = await readResponseBody(
        page,
        "Fetch.getResponseBody",
        response.requestId,
      );
      expect(
        response.status,
        JSON.stringify({ response, body: originalBody }),
      ).toBe(200);
      expect([...pinRequests.keys()]).toEqual([response.networkId]);
      expect(pinRequests.get(response.networkId)).toEqual(response.input);
      expect(completed.has(response.networkId)).toBe(false);
      expect(
        z
          .array(requestFactSchema)
          .parse(page.requests)
          .find((request) => request.requestId === response.networkId),
      ).toMatchObject({ state: "pending" });
      const meta = codeTaskPinMetaSchema.parse(
        z
          .object({ result: z.unknown() })
          .parse(JSON.parse(originalBody)).result,
      );
      return { ...response, meta };
    },
    async release() {
      if (!held || originalBody === undefined)
        throw new Error("原置顶响应尚未暂停并读取。");
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
      ); // 等待原 ACK 与其引起的真实项目树重读结束。
      expect(
        await readResponseBody(
          page,
          "Network.getResponseBody",
          response.networkId,
        ),
      ).toBe(originalBody);
    },
    expectOnlyFirstPin() {
      expect(failures).toEqual([]);
      expect(pins).toHaveLength(1);
      expect([...pinRequests.keys()]).toEqual([held?.networkId]);
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
        throw new AggregateError(failures, "原置顶响应暂停或释放失败", {
          cause: failures[0],
        });
    },
  };
}

async function withPinRoot(
  context: ProjectionContext,
  work: (surface: TaskGroupPublicPageContext) => Promise<void>,
) {
  const { fixture, session } = context;
  const previewTitle = "置顶操作保留内容.txt";
  const previewPath = join(session.workspacePath, previewTitle);
  await writeFile(previewPath, "置顶操作保留原内容\n", "utf8");
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
    const surface = await prepareCurrentContent(
      context,
      page,
      previewPath,
      previewTitle,
    );
    expect(surface.snapshotBefore.control.phase).toBe("completedSuccess");
    await work(surface);
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
    throw new AggregateError(failures, "原 Task 置顶验证或浏览器关闭失败", {
      cause: failures[0],
    });
}

async function exerciseLatePinAck(
  context: ProjectionContext,
  surface: TaskGroupPublicPageContext,
) {
  const { client, session } = context;
  const { page } = surface;
  const target = {
    taskId: session.sessionId,
    workspacePath: session.workspacePath,
    workspaceIdentity: JSON.stringify([
      session.projectId,
      session.workspacePath,
    ]),
  };
  const readCurrent = async () =>
    codeTaskPinMetaSchema.parse(
      await client.services.zcodeTaskService.getTaskMeta(target),
    );
  const initial = await readCurrent();
  expect(initial.pinned).toBe(false);
  await expectPinnedPlacement(surface, false);
  await openPinMenu(surface, false);
  const pending = await holdFirstPinResponse(page, session.sessionId);
  try {
    await pressKey(page.cdp, page.target.sessionId, "Enter");
    const first = await pending.waitForHeld();
    expect(first.input).toEqual({
      ...target,
      taskControl: initial.taskControl,
      observedPinRevision: initial.pinRevision,
      pinned: true,
    });
    expect(first.meta).toMatchObject({
      ...target,
      pinned: true,
      pinRevision: initial.pinRevision + 1,
    });
    const committed = await readCurrent();
    expect(committed).toEqual(first.meta);
    // Projection fixture 的 client 已独立连接并完成 initializeConversationV4。
    const unpinned = codeTaskPinMetaSchema.parse(
      await client.services.zcodeTaskService.setTaskPinned({
        ...target,
        taskControl: structuredClone(committed.taskControl),
        observedPinRevision: committed.pinRevision,
        pinned: false,
      }),
    );
    expect(unpinned).toMatchObject({
      ...target,
      pinned: false,
      pinRevision: committed.pinRevision + 1,
    });
    expect(await readCurrent()).toEqual(unpinned);
    await expectContentPreserved(surface);
    await pending.release();
    await expectPinnedPlacement(surface, false);
    await expectContentPreserved(surface);
    expect(await readCurrent()).toEqual(unpinned);
    expect(
      protocol.conversationSnapshotSchema.parse(await session.snapshot()),
    ).toEqual(surface.snapshotBefore);
    expect(await readScope(session)).toEqual(surface.scopeBefore);
    expect(context.model.requests).toHaveLength(
      surface.modelRequestCountBefore,
    );
    pending.expectOnlyFirstPin();
  } finally {
    await pending.close();
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 ProjectSidebar Task 置顶的 Root、HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("原菜单置顶、取消与再次置顶更新真实项目树和原分区，Task正文、权限、草稿和当前内容保持", async () => {
      await withProjectionResources(async (context) => {
        await withPinRoot(context, exercisePin);
      });
    }, 180_000); // 原 Root、三次真实菜单操作与全部资源关闭期限。
    it("原置顶 ACK 暂停时另一真实连接取消置顶，释放旧 ACK 后保持当前取消状态与原内容", async () => {
      await withProjectionResources(async (context) => {
        await withPinRoot(context, (surface) =>
          exerciseLatePinAck(context, surface),
        );
      });
    }, 180_000); // 原 Root、真实响应暂停、独立连接取消置顶及资源关闭期限。
    it("原 Header 本机 Task 菜单直接置顶和取消，发送当前修订并保持原会话、草稿与内容", async () => {
      await withProjectionResources(async (context) => {
        await withPinRoot(context, exerciseHeaderPin);
      });
    }, 180_000); // 原 Root、Header 实际菜单与两次直接 HTTP 请求的资源关闭期限。
  },
);
