// @vitest-environment node
import { join } from "node:path";
import {
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  codeUiWorkspaceSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const workspaceTrigger = '[data-testid="composer-workspace-trigger"]';
const outsideSelector = '[data-testid="composer-work-outside-project"]';
const conversationSchema = codeUiWorkspaceSchema.extend({
  created: z.boolean(),
  workspacePurpose: z.literal("conversation"),
});
const requestFactSchema = z.object({
  requestId: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  state: z.string(),
  status: z.number().optional(),
});
const commandRequestSchema = z.object({
  args: z.tuple([
    z.object({
      projectId: z.uuid().optional(),
      workspacePath: z.string(),
      workspaceIdentity: z.string().optional(),
      envelope: protocol.commandEnvelopeSchema,
    }),
  ]),
});

function requestFacts(page: OriginalSessionBrowser) {
  return z.array(requestFactSchema).parse(page.requests);
}

async function readResult(page: OriginalSessionBrowser, requestId: string) {
  const response = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      ),
    );
  const body = response.base64Encoded
    ? Buffer.from(response.body, "base64").toString("utf8")
    : response.body;
  return z.object({ result: z.unknown() }).parse(JSON.parse(body)).result;
}

async function clickVisible(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || !element.checkVisibility() || element.disabled) return null;
        element.scrollIntoView({ block: 'center' });
        await new Promise(requestAnimationFrame);
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && element.contains(hit) ? { x, y } : null;
      })()`,
    );
    const dom = found
      ? null
      : await page.evaluate(`(() => {
          const selector = ${JSON.stringify(selector)};
          const describe = element => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const panel = element.closest('[aria-hidden]');
            return {
              html: element.outerHTML,
              visible: element.checkVisibility(),
              disabled: element.disabled,
              rect: rect.toJSON(),
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              pointerEvents: style.pointerEvents,
              hiddenAncestor: panel ? {
                testId: panel.getAttribute('data-testid'),
                ariaHidden: panel.getAttribute('aria-hidden'),
                className: panel.className,
              } : null,
            };
          };
          const target = document.querySelector(selector);
          const rect = target?.getBoundingClientRect();
          const hit = rect ? document.elementFromPoint(
            rect.left + rect.width / 2, rect.top + rect.height / 2,
          ) : null;
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          return {
            selector,
            sessionId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
            inputValue: input?.textContent,
            activeElement: describe(document.activeElement),
            target: describe(target),
            candidates: Array.from(document.querySelectorAll(selector), describe),
            hit: describe(hit),
            menus: Array.from(document.querySelectorAll('[role="menu"]'))
              .filter(element => element.checkVisibility()).map(describe),
            sidePanes: Array.from(document.querySelectorAll(
              '[data-testid="preview-pane"], [data-testid="workspace-file-tree-panel"], [data-side-pane-tab-id][data-state="active"]',
            )).map(describe),
            dialogs: Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-overlay"]'))
              .filter(element => element.checkVisibility()).map(describe),
            viewport: { width: innerWidth, height: innerHeight },
          };
        })()`);
    expect(
      found,
      JSON.stringify({ selector, dom, pageErrors: page.pageErrors }),
    ).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原界面操作入口尚未显示。");
  await clickOn(page.cdp, page.target.sessionId, point);
}

async function waitForConversationWorkspace(
  page: OriginalSessionBrowser,
  previous: ReadonlySet<string>,
) {
  return vi.waitFor(
    async () => {
      const request = requestFacts(page).find(
        (fact) =>
          !previous.has(fact.requestId) &&
          fact.service === "file" &&
          fact.method === "ensureConversationWorkspace" &&
          fact.state === "finished" &&
          fact.status === 200,
      );
      if (!request)
        throw new Error(
          `原对话目录尚无真实回执：${JSON.stringify(page.requests)}`,
        );
      return conversationSchema.parse(
        await readResult(page, request.requestId),
      );
    },
    { timeout: 15_000 },
  );
}

async function readCommand(page: OriginalSessionBrowser, requestId: string) {
  const post = z
    .object({ postData: z.string() })
    .parse(
      await page.cdp.send(
        "Network.getRequestPostData",
        { requestId },
        page.target.sessionId,
      ),
    );
  return {
    input: commandRequestSchema.parse(JSON.parse(post.postData)).args[0],
    ack: protocol.commandAckSchema.parse(await readResult(page, requestId)),
  };
}

async function expectConversationTask(
  context: TaskGroupPublicPageContext,
  conversation: z.infer<typeof conversationSchema>,
  previous: ReadonlySet<string>,
) {
  const { page, host } = context;
  const commands = new Map<string, Awaited<ReturnType<typeof readCommand>>>();
  return vi.waitFor(
    async () => {
      const requests = requestFacts(page).filter(
        (fact) =>
          !previous.has(fact.requestId) &&
          fact.service === "zcodeAgentService" &&
          fact.method === "sendConversationCommandV4" &&
          fact.state === "finished" &&
          fact.status === 200,
      );
      for (const request of requests)
        if (!commands.has(request.requestId))
          commands.set(
            request.requestId,
            await readCommand(page, request.requestId),
          );
      const created = [...commands.values()].find(
        ({ input, ack }) =>
          input.projectId === conversation.projectId &&
          input.envelope.type === "createSession" &&
          ack.status === "accepted" &&
          ack.result?.type === "createSession",
      );
      if (!created)
        throw new Error(
          `原对话草稿尚无真实Task回执：${JSON.stringify({ requests, errors: page.pageErrors })}`,
        );
      expect(created.input.workspacePath).toBe(conversation.path);
      expect(
        protocol.commandPayloadSchemas.createSession.parse(
          created.input.envelope.payload,
        ).workspaceId,
      ).toBe(conversation.projectId);
      expect(created.ack.result).toMatchObject({
        type: "createSession",
        taskControl: { projectId: conversation.projectId },
      });
      const taskId = z
        .uuid()
        .parse(
          created.ack.result?.type === "createSession"
            ? created.ack.result.sessionId
            : null,
        );
      const response = await host.client.request(
        `/api/code-ui/tasks/${taskId}/scope`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        codeTaskScopeResponseSchema.parse(response.body).scope,
      ).toMatchObject({
        instanceId: context.scopeBefore.instanceId,
        projectId: conversation.projectId,
        taskId,
        rootDirectory: conversation.path,
        additionalDirectories: [],
      });
      return { taskId };
    },
    { timeout: 15_000 },
  ); // 仅观察原草稿预热，不代发Task创建或模型输入。
}

async function refreshByBrowserFocus(page: OriginalSessionBrowser) {
  await page.cdp.send("Page.bringToFront", {}, page.target.sessionId);
  await vi.waitFor(async () =>
    expect(await page.evaluate("document.hasFocus()")).toBe(true),
  );
  const other = await page.cdp.openTab("about:blank");
  try {
    await page.cdp.send("Target.activateTarget", { targetId: other.targetId });
    await vi.waitFor(async () =>
      expect(await page.evaluate("document.hasFocus()")).toBe(false),
    );
    await page.cdp.send("Target.activateTarget", {
      targetId: page.target.targetId,
    });
    await page.cdp.send("Page.bringToFront", {}, page.target.sessionId);
    await vi.waitFor(async () =>
      expect(await page.evaluate("document.hasFocus()")).toBe(true),
    );
  } finally {
    await page.cdp.closeTab(other.targetId);
  }
}

async function expectBrowserDirectorySynced(
  page: OriginalSessionBrowser,
  conversation: z.infer<typeof conversationSchema>,
) {
  const previous = new Set(
    requestFacts(page).map((request) => request.requestId),
  );
  await refreshByBrowserFocus(page);
  const results = new Map<string, z.infer<typeof codeProjectTreeSchema>>();
  await vi.waitFor(
    async () => {
      const requests = requestFacts(page).filter(
        (fact) =>
          !previous.has(fact.requestId) &&
          fact.service === "project" &&
          fact.method === "readTree" &&
          fact.state === "finished" &&
          fact.status === 200,
      );
      for (const request of requests)
        if (!results.has(request.requestId))
          results.set(
            request.requestId,
            codeProjectTreeSchema.parse(
              await readResult(page, request.requestId),
            ),
          );
      const project = [...results.values()]
        .flatMap((tree) => tree.projects)
        .find((entry) => entry.id === conversation.projectId);
      expect(
        project,
        JSON.stringify({ requests, errors: page.pageErrors }),
      ).toMatchObject({
        id: conversation.projectId,
        hostId: "local",
        name: conversation.name,
        roots: [{ rootPath: conversation.path, position: 0, isPrimary: true }],
      });
    },
    { timeout: 15_000 },
  ); // 等待原目录消费者的真实200响应包含持久默认对话Project。
}

async function expectConversationMenu(page: OriginalSessionBrowser) {
  await clickVisible(page, workspaceTrigger);
  await vi.waitFor(
    async () => {
      const state = await page.evaluate(`(() => {
        const outside = document.querySelector(${JSON.stringify(outsideSelector)});
        const visible = selector => Array.from(document.querySelectorAll(selector))
          .filter(element => element.checkVisibility());
        return {
          outsideVisible: outside?.checkVisibility(),
          outsideChecked: outside?.getAttribute('aria-checked'),
          trigger: document.querySelector(${JSON.stringify(workspaceTrigger)})?.textContent.trim(),
          editCount: visible('[data-testid="composer-edit-project"]').length,
          detachCount: visible('[data-testid="composer-project-detach"]').length,
          selectedProjectIds: visible('[role="menu"] [data-project-id][aria-checked="true"]')
            .map(element => element.getAttribute('data-project-id')),
          menu: document.querySelector('[data-testid="composer-project-menu"]')?.outerHTML,
        };
      })()`);
      expect(
        state,
        JSON.stringify({ state, errors: page.pageErrors }),
      ).toMatchObject({
        outsideVisible: true,
        outsideChecked: "true",
        trigger: "选择项目",
        editCount: 0,
        detachCount: 0,
        selectedProjectIds: [],
      });
    },
    { timeout: 15_000 },
  );
  await closeConversationMenu(page);
}

async function closeConversationMenu(page: OriginalSessionBrowser) {
  await vi.waitFor(async () => {
    const state = await page.evaluate(`(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const menu = document.querySelector('[data-testid="composer-project-menu"]');
      return {
        visible: menu?.checkVisibility(),
        state: menu?.getAttribute('data-state'),
        focused: Boolean(menu?.contains(document.activeElement)),
        pointerEvents: menu ? getComputedStyle(menu).pointerEvents : null,
        activeElement: document.activeElement?.outerHTML,
        menu: menu?.outerHTML,
      };
    })()`);
    expect(state, JSON.stringify(state)).toMatchObject({
      visible: true,
      state: "open",
      focused: true,
      pointerEvents: "auto",
    });
  });
  const keys = await observeEscapeKeys(page);
  try {
    await pressKey(page.cdp, page.target.sessionId, "Escape");
    const observed = await vi.waitFor(async () => {
      const events = await keys.read();
      const state = await page.evaluate(`(() => {
        const menu = document.querySelector('[data-testid="composer-project-menu"]');
        return { present: Boolean(menu), menu: menu?.outerHTML,
          activeElement: document.activeElement?.outerHTML,
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents };
      })()`);
      const diagnostics = JSON.stringify({
        events,
        state,
        errors: page.pageErrors,
      });
      expect(
        events.map(({ type, key, trusted }) => ({ type, key, trusted })),
        diagnostics,
      ).toEqual([
        { type: "keydown", key: "Escape", trusted: true },
        { type: "keyup", key: "Escape", trusted: true },
      ]);
      expect(state, diagnostics).toMatchObject({ present: false });
      return { events, state };
    });
    console.info("原项目菜单 Escape", JSON.stringify(observed));
  } finally {
    await keys.close();
  }
}

async function observeEscapeKeys(page: OriginalSessionBrowser) {
  const { result } = z
    .object({ result: z.object({ objectId: z.string() }) })
    .parse(
      await page.cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
        const events = [];
        const observe = event => {
          if (event.key !== 'Escape') return;
          setTimeout(() => events.push({
            type: event.type,
            key: event.key,
            trusted: event.isTrusted,
            defaultPrevented: event.defaultPrevented,
            target: event.target?.outerHTML ?? null,
          }), 0);
        };
        window.addEventListener('keydown', observe, true);
        window.addEventListener('keyup', observe, true);
        return { events, close: () => {
          window.removeEventListener('keydown', observe, true);
          window.removeEventListener('keyup', observe, true);
        } };
      })()`,
        },
        page.target.sessionId,
      ),
    );
  return {
    async read() {
      return z
        .object({
          result: z.object({
            value: z.array(
              z.object({
                type: z.string(),
                key: z.string(),
                trusted: z.boolean(),
                defaultPrevented: z.boolean(),
                target: z.string().nullable(),
              }),
            ),
          }),
        })
        .parse(
          await page.cdp.send(
            "Runtime.callFunctionOn",
            {
              objectId: result.objectId,
              functionDeclaration: "function () { return this.events; }",
              returnByValue: true,
            },
            page.target.sessionId,
          ),
        ).result.value;
    },
    async close() {
      try {
        await page.cdp.send(
          "Runtime.callFunctionOn",
          {
            objectId: result.objectId,
            functionDeclaration: "function () { this.close(); }",
          },
          page.target.sessionId,
        );
      } finally {
        await page.cdp.send(
          "Runtime.releaseObject",
          { objectId: result.objectId },
          page.target.sessionId,
        );
      }
    },
  };
}

async function expectOriginalTaskRestored(
  context: TaskGroupPublicPageContext,
  previewText: string,
) {
  const { page, host, draft, previewTitle, scopeBefore, snapshotBefore } =
    context;
  await clickVisible(page, `[data-testid="task-item-${host.sessionId}"]`);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
      return {
        taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
        draft: input?.textContent,
        previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
        previewText: document.querySelector('[data-testid="preview-pane"]')?.textContent,
      };
    })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ taskId: host.sessionId, draft, previewTitle, previewText }),
  );
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
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目菜单不使用项目的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("不使用项目保留持久对话工作域，目录同步后仍正确选中且原A任务可返回", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host, model } = context;
          const previewText = z
            .string()
            .parse(
              await page.evaluate(
                'document.querySelector("[data-testid=preview-pane]")?.textContent',
              ),
            );
          await clickVisible(
            page,
            '[data-testid="sidebar"] [data-testid="task-new-button"]',
          );
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id')`,
              ),
            ).toBe("draft"),
          );
          await clickVisible(page, workspaceTrigger);
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(outsideSelector)})?.getAttribute('aria-checked')`,
              ),
            ).toBe("false"),
          );
          const previous = new Set(
            requestFacts(page).map((request) => request.requestId),
          );
          await clickVisible(page, outsideSelector);
          const conversation = await waitForConversationWorkspace(
            page,
            previous,
          );
          expect(conversation.projectId).not.toBe(host.projectId);
          const created = await expectConversationTask(
            context,
            conversation,
            previous,
          );
          expect(created.taskId).not.toBe(host.sessionId);
          await expectBrowserDirectorySynced(page, conversation);
          await expectConversationMenu(page);
          await expectOriginalTaskRestored(context, previewText);
          expect(model.requests).toHaveLength(context.modelRequestCountBefore);
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root、独占Chrome真实焦点、HTTP/SSE/临时PG与资源关闭期限。
  },
);
