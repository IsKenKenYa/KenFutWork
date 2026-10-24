// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  codeProjectTreeSchema,
  codeTaskGroupSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
// 仅为独占浏览器产生超过一个视口的真实列表，不属于运行时预算。
const scrollGroupCount = 20;

async function readTree({ host }: TaskGroupPublicPageContext) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function groupCommand(
  { host }: TaskGroupPublicPageContext,
  method: "admit" | "save" | "move",
  input: unknown,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.result;
}

async function prepareScrollableGroups(context: TaskGroupPublicPageContext) {
  const tree = await readTree(context);
  const task = tree.tasks.find(
    (entry) => entry.taskId === context.host.sessionId,
  );
  if (!task?.workspaceIdentity)
    throw new Error("吸顶键盘验收缺少已有历史的真实 Task。");
  const reference = {
    hostId: task.hostId,
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  await groupCommand(context, "admit", { tasks: [reference] });
  const groups = [];
  for (let index = 0; index < scrollGroupCount; index += 1) {
    const before = await readGroups(context.host);
    const group = codeTaskGroupSchema.parse(
      await groupCommand(context, "save", {
        creationId: randomUUID(),
        expectedRevision: before.revision,
        title: `键盘滚动分组 ${index + 1}`,
      }),
    );
    groups.push(group);
  }
  const target = groups[Math.floor(groups.length / 2)];
  if (!target) throw new Error("吸顶键盘验收没有创建目标分组。");
  const beforeMove = await readGroups(context.host);
  await groupCommand(context, "move", {
    node: { type: "task", task: reference },
    sourceGroupId:
      beforeMove.members.find((member) => member.taskId === task.taskId)
        ?.groupId ?? null,
    groupId: target.id,
    expectedRevision: beforeMove.revision,
  });
  const structure = await readGroups(context.host);
  expect(structure.groups).toHaveLength(scrollGroupCount);
  expect(
    structure.members.filter((member) => member.taskId === task.taskId),
  ).toEqual([
    expect.objectContaining({ taskId: task.taskId, groupId: target.id }),
  ]);
  return { target, tree, structure };
}

async function findScrollContainer(page: OriginalSessionBrowser) {
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="task-grouped-view"]');
    let element = root?.parentElement;
    while (element) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
        window.__stickyKeyboardScroll = element;
        return element.clientHeight > 0;
      }
      element = element.parentElement;
    }
    return false;
  })()`),
        JSON.stringify(page.pageErrors),
      ).toBe(true),
    {
      timeout: 10_000,
    },
  ); // 等待真实分组及虚拟列表形成可滚动内容。
}

async function returnToTaskList(page: OriginalSessionBrowser) {
  const fileTreeOpen = await page.evaluate<boolean>(`(() => {
    const panel = document.querySelector('[data-testid="workspace-file-tree-panel"]');
    return Boolean(panel && panel.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false');
  })()`);
  if (fileTreeOpen)
    await clickExactText(
      page,
      '[data-testid="workspace-file-tree-panel"] button',
      "返回任务",
    );
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="workspace-file-tree-panel"]');
    const root = document.querySelector('[data-testid="task-grouped-view"]');
    return {
      fileTreeClosed: !panel || panel.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'true',
      taskListAvailable: Boolean(root && !root.closest('[inert], [hidden], [aria-hidden="true"]')),
    };
  })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({
        fileTreeClosed: true,
        taskListAvailable: true,
      }),
    { timeout: 5_000 },
  ); // 通过原返回按钮结束文件树操作，等待当前任务列表接纳键盘。
}

async function scrollToStickyHeader(
  page: OriginalSessionBrowser,
  groupId: string,
) {
  await returnToTaskList(page);
  await findScrollContainer(page);
  let positioned = false;
  for (let step = 0; step < scrollGroupCount && !positioned; step += 1) {
    positioned = await page.evaluate<boolean>(`(async () => {
      const scroll = window.__stickyKeyboardScroll;
      const header = document.querySelector('[data-grouped-group-header-id=${JSON.stringify(groupId)}]');
      if (header) {
        const rect = header.getBoundingClientRect();
        scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top + rect.height / 2;
      } else {
        scroll.scrollTop += scroll.clientHeight / 2;
      }
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return Boolean(header);
    })()`);
  }
  expect(positioned, "真实滚动未找到目标组头").toBe(true);
  const selector = `[data-grouped-sticky-header=${JSON.stringify(groupId)}] button[aria-label="新建任务"]`;
  await vi.waitFor(
    async () => {
      const observation = await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const button = buttons[0];
      const group = document.querySelector('[data-task-group-id=${JSON.stringify(groupId)}]');
      const header = group?.querySelector('[data-grouped-group-header-id]');
      const scroll = window.__stickyKeyboardScroll;
      const buttonMatches = buttons.map(element => {
        const ancestors = [];
        let ancestor = element;
        while (ancestor) {
          ancestors.push({ tag: ancestor.tagName, attributes: Object.fromEntries(
            Array.from(ancestor.attributes).filter(attribute =>
              /^(data-|aria-hidden$|inert$|hidden$|id$|role$)/.test(attribute.name)
            ).map(attribute => [attribute.name, attribute.value])
          ) });
          ancestor = ancestor.parentElement;
        }
        return { connected: element.isConnected, disabled: element.disabled, ancestors };
      });
      const containers = [];
      let parent = document.querySelector('[data-testid="task-grouped-view"]')?.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll)/.test(style.overflowY)) containers.push({
          tag: parent.tagName, connected: parent.isConnected, selected: parent === scroll,
          top: parent.getBoundingClientRect().top, scrollTop: parent.scrollTop,
          height: parent.clientHeight, scrollHeight: parent.scrollHeight,
        });
        parent = parent.parentElement;
      }
      return {
        matches: buttons.length,
        visible: Boolean(button?.checkVisibility()),
        enabled: Boolean(button && !button.disabled),
        inert: Boolean(button?.closest('[inert]')),
        hidden: Boolean(button?.closest('[hidden]')),
        expanded: header?.getAttribute('aria-expanded') ?? null,
        collapsed: group?.getAttribute('data-group-collapsed') ?? null,
        headerAboveViewport: Boolean(header && scroll && header.getBoundingClientRect().top < scroll.getBoundingClientRect().top),
        stickyGroups: Array.from(document.querySelectorAll('[data-grouped-sticky-header]'))
          .map(element => ({ id: element.getAttribute('data-grouped-sticky-header'), connected: element.isConnected })),
        buttonMatches,
        scrollContainers: containers,
      };
    })()`);
      expect(
        observation,
        JSON.stringify({ observation, errors: page.pageErrors }),
      ).toMatchObject({
        matches: 1,
        visible: true,
        enabled: true,
        inert: false,
        hidden: false,
        expanded: "true",
        collapsed: "false",
        headerAboveViewport: true,
      });
    },
    { timeout: 10_000 },
  ); // 滚动后等待原吸顶组件实际挂载并接纳键盘焦点。
  return selector;
}

async function focusAndPressEnter(
  page: OriginalSessionBrowser,
  selector: string,
) {
  await vi.waitFor(
    async () => {
      const observation = await page.evaluate(`(async () => {
      const buttons = document.querySelectorAll(${JSON.stringify(selector)});
      const button = buttons[0];
      button?.focus({ preventScroll: true });
      await new Promise(requestAnimationFrame);
      const current = document.querySelector(${JSON.stringify(selector)});
      const active = document.activeElement;
      const rect = current?.getBoundingClientRect();
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      const ancestors = [];
      let ancestor = current;
      while (ancestor) {
        ancestors.push({ tag: ancestor.tagName, attributes: Object.fromEntries(
          Array.from(ancestor.attributes).filter(attribute =>
            /^(data-|aria-hidden$|inert$|hidden$|id$|role$)/.test(attribute.name)
          ).map(attribute => [attribute.name, attribute.value])
        ) });
        ancestor = ancestor.parentElement;
      }
      return {
        matches: buttons.length,
        connected: Boolean(current?.isConnected),
        inert: Boolean(current?.closest('[inert]')),
        hidden: Boolean(current?.closest('[hidden]')),
        ariaHidden: Boolean(current?.closest('[aria-hidden="true"]')),
        focused: Boolean(current && active === current),
        sameButton: current === button,
        visibility: current ? getComputedStyle(current).visibility : null,
        hit: Boolean(current && hit && current.contains(hit)),
        buttonAncestors: ancestors,
        hitElement: hit ? { tag: hit.tagName, label: hit.getAttribute('aria-label'), testId: hit.getAttribute('data-testid') } : null,
        active: active ? {
          tag: active.tagName,
          label: active.getAttribute('aria-label'),
          testId: active.getAttribute('data-testid'),
        } : null,
      };
    })()`);
      expect(
        observation,
        JSON.stringify({ observation, errors: page.pageErrors }),
      ).toMatchObject({
        matches: 1,
        connected: true,
        inert: false,
        hidden: false,
        ariaHidden: false,
        focused: true,
        sameButton: true,
        visibility: "visible",
        hit: true,
      });
    },
    { timeout: 5_000 },
  ); // 原吸顶头滚动及重新渲染结束后，当前按钮必须真实持有焦点。
  // 原生按钮依赖完整 Enter 按键产生 click；字符随 keyDown 交给浏览器处理。
  await page.cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    },
    page.target.sessionId,
  );
  await page.cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    page.target.sessionId,
  );
}

async function expectExpandedGroupDraft(
  { page, previewTitle }: TaskGroupPublicPageContext,
  groupId: string,
) {
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const draft = document.querySelector('[data-testid="grouped-draft-task"]');
    const group = document.querySelector('[data-task-group-id=${JSON.stringify(groupId)}]');
    const preview = document.querySelector('[data-testid="preview-pane"]');
    return {
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      text: input?.textContent,
      draftGroupId: draft?.closest('[data-task-group-id]')?.getAttribute('data-task-group-id'),
      collapsed: group?.getAttribute('data-group-collapsed'),
      expanded: group?.querySelector('[data-grouped-group-header-id]')?.getAttribute('aria-expanded'),
      previewPreserved: Boolean(preview?.isConnected && preview === window.__taskGroupPublicBefore.preview),
      previewTitle: preview?.querySelector(':scope > div:first-child span.truncate')?.textContent,
    };
  })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({
        taskId: "draft",
        text: "",
        draftGroupId: groupId,
        collapsed: "false",
        expanded: "true",
        previewPreserved: true,
        previewTitle,
      }),
    { timeout: 5_000 },
  ); // 原按钮的Enter创建指定组草稿并保持父组展开。
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原吸顶组头键盘的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("吸顶组头的新建任务按钮按Enter创建指定组草稿且父组保持展开", async () => {
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
          const { target, tree, structure } =
            await prepareScrollableGroups(context);
          const button = await scrollToStickyHeader(page, target.id);
          await focusAndPressEnter(page, button);
          await expectExpandedGroupDraft(context, target.id);
          expect(await readGroups(host)).toEqual(structure);
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
    }, 180_000); // 真实列表、实际滚动与键盘、原Root、HTTP/SSE及临时PG关闭期限。
  },
);
