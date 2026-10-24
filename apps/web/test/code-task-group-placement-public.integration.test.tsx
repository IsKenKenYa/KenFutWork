// @vitest-environment node
import {
  codeTaskScopeResponseSchema,
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
import {
  createGroupFromUi,
  dismissGroupSetup,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const sendSelector = '[data-testid="v4-composer-send"]';
const stopSelector = '[data-testid="v4-stop"]';

async function observeSendDom(page: OriginalSessionBrowser) {
  await page.evaluate(`(() => {
    const visible = element => element.checkVisibility() &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]');
    const identify = element => element instanceof Element ? {
      tag: element.tagName, testId: element.getAttribute('data-testid'),
      label: element.getAttribute('aria-label'), role: element.getAttribute('role'),
    } : null;
    const evidence = { events: [], states: [], measurements: [] };
    window.__placementSendDom = evidence;
    let previousState = '';
    const snapshot = () => {
      const inputs = Array.from(document.querySelectorAll(${JSON.stringify(inputSelector)})).filter(visible);
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(sendSelector)})).filter(visible);
      const input = inputs[0];
      const button = buttons[0];
      const model = document.querySelector('[data-testid="v4-model-config"]');
      const state = {
        inputs: inputs.length, buttons: buttons.length, inputText: input?.textContent,
        taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
        disabled: button?.disabled, spinner: Boolean(button?.querySelector('[role="status"]')),
        sameForm: Boolean(input && button && input.closest('form') === button.form),
        provider: model?.getAttribute('data-provider'), model: model?.getAttribute('data-model'),
        active: identify(document.activeElement),
      };
      const signature = JSON.stringify(state);
      if (signature !== previousState) evidence.states.push({ at: performance.now(), ...state });
      previousState = signature;
    };
    const record = event => {
      const target = event.target;
      const entry = {
        type: event.type, at: performance.now(), isTrusted: event.isTrusted,
        target: identify(target),
        sendTarget: target instanceof Element && Boolean(target.closest(${JSON.stringify(sendSelector)})),
        defaultPreventedAtCapture: event.defaultPrevented,
        key: event instanceof KeyboardEvent ? event.key : undefined,
        clientX: event instanceof MouseEvent ? event.clientX : undefined,
        clientY: event instanceof MouseEvent ? event.clientY : undefined,
        relatedTarget: identify(event.relatedTarget),
        submitter: identify(event.submitter),
      };
      evidence.events.push(entry);
      queueMicrotask(() => { entry.defaultPrevented = event.defaultPrevented; snapshot(); });
    };
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'submit', 'blur', 'focusout', 'keydown'];
    for (const type of types) document.addEventListener(type, record, { capture: true, passive: true });
    const observer = new MutationObserver(snapshot);
    observer.observe(document.body, { childList: true, subtree: true,
      attributes: true, attributeFilter: ['disabled', 'data-model', 'data-provider', 'data-session-id', 'inert', 'aria-hidden'] });
    snapshot();
    window.__placementSendDomOff = () => {
      for (const type of types) document.removeEventListener(type, record, true);
      observer.disconnect();
    };
  })()`);
  return {
    read: () => page.evaluate(`window.__placementSendDom`),
    dispose: () => page.evaluate(`window.__placementSendDomOff?.()`),
  };
}

async function measureSendLayout(page: OriginalSessionBrowser, text: string) {
  const measured = await vi.waitFor(
    async () => {
      const observation = await page.evaluate<{
        ready: boolean;
        point?: { x: number; y: number };
      }>(`(async () => {
      const visible = element => element.checkVisibility() &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]');
      const inputs = Array.from(document.querySelectorAll(${JSON.stringify(inputSelector)})).filter(visible);
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(sendSelector)})).filter(visible);
      const input = inputs[0];
      const button = buttons[0];
      if (inputs.length !== 1 || buttons.length !== 1) return { ready: false, inputs: inputs.length, buttons: buttons.length };
      input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(requestAnimationFrame);
      const rects = [input, button].map(element => element.getBoundingClientRect());
      await new Promise(requestAnimationFrame);
      const next = [input, button].map(element => element.getBoundingClientRect());
      const stable = rects.every((rect, index) =>
        ['left', 'top', 'width', 'height'].every(key => rect[key] === next[index][key]));
      const point = { x: next[1].left + next[1].width / 2, y: next[1].top + next[1].height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const taskId = input.closest('[data-session-id]')?.getAttribute('data-session-id');
      const ready = stable && input.isConnected && button.isConnected && !button.disabled &&
        taskId === 'draft' && input.textContent === ${JSON.stringify(text)} && input.closest('form') === button.form &&
        hit && button.contains(hit) && !button.closest('[inert], [hidden], [aria-hidden="true"]');
      const result = {
        ready: Boolean(ready), point, stable, text: input.textContent,
        inputTaskId: taskId,
        disabled: button.disabled, sameForm: input.closest('form') === button.form,
        hit: hit ? { tag: hit.tagName, testId: hit.getAttribute('data-testid'), label: hit.getAttribute('aria-label') } : null,
        inputRect: { x: next[0].x, y: next[0].y, width: next[0].width, height: next[0].height },
        buttonRect: { x: next[1].x, y: next[1].y, width: next[1].width, height: next[1].height },
      };
      if (result.ready) window.__placementSendDom.measurements.push(result);
      return result;
    })()`);
      expect(observation, JSON.stringify(observation)).toMatchObject({
        ready: true,
      });
      return observation;
    },
    { timeout: 10_000 },
  ); // 唯一可见输入与发送按钮的两帧几何、正文和命中共同成立后才操作。
  if (!measured.point) throw new Error("原发送按钮缺少稳定的实际位置。");
  return measured.point;
}

async function clickSendOnce(page: OriginalSessionBrowser, text: string) {
  const initial = await measureSendLayout(page, text);
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...initial },
    page.target.sessionId,
  );
  const point = await measureSendLayout(page, text);
  // 只发出一次原生按下和释放；后续证据等待不再次点击发送。
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    },
    page.target.sessionId,
  );
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1,
    },
    page.target.sessionId,
  );
  const evidence = await page.evaluate<{
    events: Array<{ type: string; sendTarget: boolean; isTrusted: boolean }>;
  }>(`window.__placementSendDom`);
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ])
    expect(
      evidence.events.filter(
        (event) => event.type === type && event.sendTarget,
      ),
      JSON.stringify(evidence),
    ).toEqual([
      expect.objectContaining({ type, sendTarget: true, isTrusted: true }),
    ]);
}

async function readSendNetwork(page: OriginalSessionBrowser) {
  const requests = z
    .array(
      z.object({
        requestId: z.string(),
        service: z.string().optional(),
        method: z.string().optional(),
        state: z.string(),
      }),
    )
    .parse(page.requests);
  const commands = requests.filter(
    (request) => request.method === "sendConversationCommandV4",
  );
  const views = requests.filter(
    (request) =>
      request.service === "modelSelectionService" &&
      request.method === "getView",
  );
  const responses = [];
  for (const request of [...commands.slice(-6), ...views.slice(-6)].filter(
    (request) => request.state === "finished",
  ))
    responses.push({
      request: await page.cdp.send(
        "Network.getRequestPostData",
        { requestId: request.requestId },
        page.target.sessionId,
      ),
      response: await page.cdp.send(
        "Network.getResponseBody",
        { requestId: request.requestId },
        page.target.sessionId,
      ),
    });
  return { requests, responses };
}

async function taskSnapshot(
  { fixture }: TaskGroupPublicPageContext,
  taskId: string,
) {
  const response = await fixture.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function waitForButton(
  { page }: TaskGroupPublicPageContext,
  selector: string,
) {
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!button || button.disabled || !button.checkVisibility()) return false;
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && button.contains(hit));
      })()`),
        JSON.stringify(page.pageErrors),
      ).toBe(true);
    },
    { timeout: 10_000 },
  ); // 仅等待原Composer或Stop实际可见并接纳点击。
}

async function sendGroupTask(
  context: TaskGroupPublicPageContext,
  groupId: string,
  text: string,
) {
  const { page, host, model, modelRequestCountBefore } = context;
  await dismissGroupSetup(page);
  const createSelector = `[data-task-group-id=${JSON.stringify(groupId)}] [data-grouped-group-header-id] button[aria-label="新建任务"]`;
  await clickOn(page.cdp, page.target.sessionId, { selector: createSelector });
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        return {
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          text: input?.textContent,
        };
      })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({ taskId: "draft", text: "" });
    },
    { timeout: 5_000 },
  ); // 原组头动作切换到新草稿的本机等待期限。
  const modelTrigger = '[data-testid="chat-model-select-trigger"]';
  await waitForButton(context, modelTrigger);
  if (
    !(await page.evaluate(
      `document.querySelector(${JSON.stringify(modelTrigger)})?.textContent.includes('stop-model')`,
    ))
  ) {
    if (
      !(await page.evaluate(
        `document.querySelector(${JSON.stringify(modelTrigger)})?.getAttribute('aria-expanded') === 'true'`,
      ))
    )
      await clickOn(page.cdp, page.target.sessionId, {
        selector: modelTrigger,
      });
    const modelSelector = await vi.waitFor(async () => {
      const id = await page.evaluate<string | null>(
        `Array.from(document.querySelectorAll('[data-testid^="chat-model-select-item-"]')).find(item => item.textContent.includes("stop-model"))?.getAttribute('data-testid') ?? null`,
      );
      expect(
        id,
        JSON.stringify({
          errors: page.pageErrors,
          menu: await page.evaluate(
            `Array.from(document.querySelectorAll('[role="menu"]')).map(menu => menu.textContent)`,
          ),
        }),
      ).not.toBeNull();
      return `[data-testid=${JSON.stringify(id)}]`;
    });
    await clickOn(page.cdp, page.target.sessionId, { selector: modelSelector });
    await pressKey(page.cdp, page.target.sessionId, "Escape");
    await pressKey(page.cdp, page.target.sessionId, "Escape");
  }
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(modelTrigger)})?.textContent`,
      ),
    ).toContain("stop-model");
  });
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  await typeText(page.cdp, page.target.sessionId, text);
  await waitForButton(context, sendSelector);
  const observation = await observeSendDom(page);
  try {
    await clickSendOnce(page, text);
    await vi.waitFor(
      () => expect(model.requests).toHaveLength(modelRequestCountBefore + 1),
      {
        timeout: 30_000,
      },
    ); // 只等待本例原Composer发送的真实本机模型HTTP请求。
  } catch (cause) {
    throw new Error(
      JSON.stringify({
        dom: await observation.read(),
        network: await readSendNetwork(page),
        ui: await page.evaluate(`document.body.textContent`),
        errors: page.pageErrors,
      }),
      { cause },
    );
  } finally {
    await observation.dispose();
  }
  const taskId = await vi.waitFor(
    async () => {
      const current = await page.evaluate<string | null>(
        `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null`,
      );
      expect(current).not.toBe(host.sessionId);
      return z.uuid().parse(current);
    },
    { timeout: 10_000 },
  ); // 模型请求已接纳后等待原DOM提交真实Task身份。
  await waitForButton(context, stopSelector);
  await clickOn(page.cdp, page.target.sessionId, { selector: stopSelector });
  const stopped = await vi.waitFor(
    async () => {
      const current = await taskSnapshot(context, taskId);
      expect(current.control.phase).toBe("completedInterrupted");
      expect(model.requests[modelRequestCountBefore]?.closed).toBe(true);
      return current;
    },
    { timeout: 30_000 },
  ); // 只等待实际原Stop按钮结束该Task及其模型HTTP流。
  expect(
    stopped.rows.window
      .filter((row) => row.kind === "userInput")
      .map((row) => row.text),
  ).toEqual([text]);
  return taskId;
}

function expectUniqueModelInput(
  { model, draft, modelRequestCountBefore }: TaskGroupPublicPageContext,
  text: string,
) {
  expect(model.requests).toHaveLength(modelRequestCountBefore + 1);
  const body = z
    .object({
      messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
    })
    .parse(model.requests[modelRequestCountBefore]?.body);
  const inputs = body.messages.filter((message) => message.role === "user");
  expect(inputs).toHaveLength(1);
  const content = JSON.stringify(inputs[0]?.content);
  expect(content).toContain(text);
  expect(content.split(text)).toHaveLength(2);
  expect(content).not.toContain(draft);
}

async function returnToOriginalTask(context: TaskGroupPublicPageContext) {
  const { page, host, draft, previewTitle } = context;
  const selector = `[data-testid="task-grouped-view"] [data-testid=${JSON.stringify(`task-item-${host.sessionId}`)}]`;
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`,
        ),
        JSON.stringify({
          errors: page.pageErrors,
          sidebar: await page.evaluate(
            `document.querySelector('[data-testid="sidebar"]')?.textContent`,
          ),
        }),
      ).toBe(true);
    },
    { timeout: 5_000 },
  ); // 等待原任务目录在创建后的SSE刷新中重新显示。
  await clickOn(page.cdp, page.target.sessionId, {
    selector,
  });
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        const preview = document.querySelector('[data-testid="preview-pane"]');
        const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
        return {
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          draft: input?.textContent,
          previewPreserved: preview === window.__taskGroupPublicBefore.preview,
          previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
        };
      })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({
        taskId: host.sessionId,
        draft,
        previewPreserved: true,
        previewTitle,
      });
    },
    { timeout: 5_000 },
  ); // 显式切回原Task后等待草稿与内容恢复。
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原组内新任务首发的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("原组头创建草稿并发送、Stop后真实Task入组，原任务草稿、文件和权限保持", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { host, fixture, page, snapshotBefore, scopeBefore } = context;
          await returnToOriginalTask(context);
          const group = await createGroupFromUi(context);
          const text = "组内新任务首发的唯一消息";
          const taskId = await sendGroupTask(context, group.id, text);
          await vi.waitFor(
            async () => {
              const current = await readGroups(host);
              expect(
                current.members.filter((member) => member.taskId === taskId),
                JSON.stringify({ pageErrors: page.pageErrors, current }),
              ).toEqual([
                {
                  groupId: group.id,
                  workspaceKey: JSON.stringify([
                    host.projectId,
                    host.workspacePath,
                  ]),
                  taskId,
                  sortOrder: 0,
                },
              ]);
              expect(current.groups).toEqual([group]);
              expect(
                current.order.some(
                  (node) =>
                    node.type === "task" &&
                    node.key ===
                      JSON.stringify([
                        JSON.stringify([host.projectId, host.workspacePath]),
                        taskId,
                      ]),
                ),
              ).toBe(false);
            },
            { timeout: 5_000 },
          ); // 原首发提升、placement RPC和组织SSE重读的本机等待期限。
          const scope = await fixture.client.request(
            `/api/code-ui/tasks/${taskId}/scope`,
          );
          expect(scope.status, JSON.stringify(scope.body)).toBe(200);
          const createdScope = codeTaskScopeResponseSchema.parse(
            scope.body,
          ).scope;
          expect(createdScope).toMatchObject({
            instanceId: scopeBefore.instanceId,
            projectId: host.projectId,
            taskId,
            rootDirectory: host.workspacePath,
            additionalDirectories: scopeBefore.additionalDirectories,
            sandboxMode: scopeBefore.sandboxMode,
          });
          expect(createdScope.generation).toBeGreaterThan(0);
          expect(await readScope(host)).toEqual(scopeBefore);
          const original = await taskSnapshot(context, host.sessionId);
          expect(original.rows.window).toEqual(snapshotBefore.rows.window);
          expect(original.taskControl).toEqual(snapshotBefore.taskControl);
          expectUniqueModelInput(context, text);
          await returnToOriginalTask(context);
          expect(context.model.requests).toHaveLength(
            context.modelRequestCountBefore + 1,
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root生产构建、独占浏览器、组内首发、真实模型HTTP及临时PG关闭期限。
    it("首次任务列表为空时，组内首发后原任务行随真实事件出现", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const { page } = context;
        expect(
          await page.evaluate(
            `document.querySelectorAll('[data-testid="task-grouped-view"] [data-task-item-key]').length`,
          ),
        ).toBe(0);
        const group = await createGroupFromUi(context);
        const taskId = await sendGroupTask(
          context,
          group.id,
          "空列表中的首次组内任务",
        );
        const selector = `[data-task-group-id=${JSON.stringify(group.id)}] [data-testid=${JSON.stringify(`task-item-${taskId}`)}]`;
        await vi.waitFor(
          async () => {
            expect(
              await page.evaluate(
                `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`,
              ),
            ).toBe(true);
          },
          { timeout: 5_000 },
        ); // 初始空目录必须消费真实首发事件并显示新Task。
        expect(
          (await readGroups(context.host)).members.map(
            (member) => member.taskId,
          ),
        ).toContain(taskId);
        expectUniqueModelInput(context, "空列表中的首次组内任务");
      });
    }, 180_000); // 初始空目录、原发送和Stop、HTTP/SSE及临时PG的完整关闭期限。
  },
);
