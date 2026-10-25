// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeUiViewerScopeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import { observeViewerRequests } from "./setup/code-file-viewer-public.fixture.js";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';

async function openTaskManager({ page, host }: TaskGroupPublicPageContext) {
  const row = `[data-testid=${JSON.stringify(`task-item-${host.sessionId}`)}]`;
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const element = document.querySelector(${JSON.stringify(row)});
      if (!element) return null;
      element.scrollIntoView({ block: 'center' });
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原Task行尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...point },
    page.target.sessionId,
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${row} button[aria-label="显示文件树"]`,
  });
  return vi.waitFor(async () => {
    const id = await page.evaluate<string | null>(
      'document.querySelector("[data-side-pane-tab-id][data-state=active]")?.getAttribute("data-side-pane-tab-id") ?? null',
    );
    expect(id).toMatch(/^file-manager:/);
    if (!id) throw new Error("原文件管理器标签未显示。");
    return id;
  });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原文件管理器的Root、文件、HTTP与PostgreSQL integration",
  () => {
    it("Task目录打开原FileManager标签，页内预览保留当前会话、草稿和权限", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host, draft, previewTitle } = context;
        await openTaskManager(context);
        await vi.waitFor(async () => {
          expect(
            await page.evaluate(
              `Array.from(document.querySelectorAll('[data-file-manager-pane]')).filter(node => node.checkVisibility()).length`,
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(1);
        });
        const file = join(host.workspacePath, previewTitle);
        const selector = `[data-file-manager-pane] [data-testid=${JSON.stringify(`workspace-file-tree-row-${file}`)}]`;
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`,
            ),
          ).toBe(true),
        );
        await clickOn(page.cdp, page.target.sessionId, { selector });
        await vi.waitFor(async () => {
          expect(
            await page.evaluate(`(() => {
            const pane = Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility());
            const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
            return { preview: Boolean(pane?.querySelector('[data-testid="preview-pane"]')), title: tab?.querySelector('[data-side-pane-tab-title]')?.textContent };
          })()`),
            JSON.stringify(page.pageErrors),
          ).toEqual({ preview: true, title: previewTitle });
        });
        expect(
          await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          return { sameInput: input === window.__taskGroupPublicBefore.input, draft: input?.textContent,
            taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') };
        })()`),
        ).toEqual({ sameInput: true, draft, taskId: host.sessionId });
        expect(await readScope(host)).toEqual(context.scopeBefore);
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(current.rows.window).toEqual(context.snapshotBefore.rows.window);
        expect(context.model.requests).toHaveLength(
          context.modelRequestCountBefore,
        );
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 原Root、实际文件读取、独占浏览器、临时PostgreSQL及资源关闭期限。

    it("关闭一个文件标签停止自己的监听，兄弟标签继续接收真实文件变化", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host } = context;
        const observation = observeViewerRequests(page);
        try {
          const first = await openTaskManager(context);
          const second = await openTaskManager(context);
          expect(first).not.toBe(second);
          const targetSchema = z.object({
            viewerScope: codeUiViewerScopeSchema,
          });
          const readyWatches = () => {
            const watches = [...observation.requests.values()].filter(
              (entry) =>
                entry.service === "file-watcher" &&
                entry.method === "watch" &&
                targetSchema.parse(entry.args[0]).viewerScope.kind === "task",
            );
            expect(watches).toHaveLength(2);
            expect(watches.every((entry) => entry.status === 200)).toBe(true);
          };
          await vi.waitFor(readyWatches, { timeout: 5_000 });
          const unwatchBefore = [...observation.requests.values()].filter(
            (entry) => entry.method === "unwatch",
          ).length;
          const selector = `[data-side-pane-tab-id=${JSON.stringify(first)}] button`;
          const point = await page.evaluate<{
            x: number;
            y: number;
          }>(`(() => {
            const button = document.querySelector(${JSON.stringify(selector)});
            const rect = button.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`);
          await page.cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mouseMoved", ...point },
            page.target.sessionId,
          );
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
            const button = document.querySelector(${JSON.stringify(selector)});
            const hit = document.elementFromPoint(${point.x}, ${point.y});
            return button.contains(hit);
          })()`),
            ).toBe(true),
          );
          await clickOn(page.cdp, page.target.sessionId, point);
          const stoppedWatch = () => {
            const closed = [...observation.requests.values()].filter(
              (entry) => entry.method === "unwatch",
            );
            expect(closed).toHaveLength(unwatchBefore + 1);
            expect(closed.at(-1)?.status).toBe(200);
          };
          await vi.waitFor(stoppedWatch, { timeout: 5_000 });
          expect(
            await page.evaluate(
              `document.querySelector('[data-side-pane-tab-id=${JSON.stringify(first)}]') === null`,
            ),
          ).toBe(true);
          const path = join(host.workspacePath, "关闭兄弟标签后仍显示.txt");
          await writeFile(path, "原监听继续刷新\n");
          const refreshedSibling = async () =>
            expect(
              await page.evaluate(`(() => {
            const pane = Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility());
            const active = document.querySelector('[data-side-pane-tab-id][data-state=active]');
            return { active: active?.getAttribute('data-side-pane-tab-id'), found: Boolean(pane?.querySelector('[data-testid=${JSON.stringify(`workspace-file-tree-row-${path}`)}]')) };
          })()`),
            ).toEqual({ active: second, found: true });
          await vi.waitFor(refreshedSibling, { timeout: 5_000 });
          expect(await readScope(host)).toEqual(context.scopeBefore);
          expect(context.model.requests).toHaveLength(
            context.modelRequestCountBefore,
          );
        } finally {
          observation.dispose();
        }
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 原标签关闭、真实watch/unwatch、文件事件与独占浏览器关闭期限。

    it("点击完成消息中的原文件链接，在同一CodeViewer标签显示原FileManager", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host, model } = context;
        const path = join(host.workspacePath, "codeviewer.svg");
        await writeFile(
          path,
          '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="23"><title>原文件链接</title></svg>',
        );
        const accepted = await host.command("sendText", {
          text: "原文件链接公开验证",
        });
        expect(accepted.status).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.writeText(1, `[打开原 CodeViewer 文件](${path})`);
        model.finish(1);
        const readCompleted = async () => {
          const current = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          expect(current.control.phase).toBe("completedSuccess");
          return current;
        };
        const completed = await vi.waitFor(readCompleted, { timeout: 30_000 });
        await clickExactText(
          page,
          "[data-session-id] a, [data-session-id] button",
          "打开原 CodeViewer 文件",
        );
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
          const pane = Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility());
          const image = pane?.querySelector('[data-testid="preview-pane"] img');
          const tab = document.querySelector('[data-side-pane-tab-id][data-state=active]');
          return { fileManager: Boolean(pane), id: tab?.getAttribute('data-side-pane-tab-id'), width: image?.naturalWidth };
        })()`),
          ).toMatchObject({
            fileManager: true,
            id: expect.stringMatching(/^code-viewer:/),
            width: 29,
          }),
        );
        expect(
          protocol.conversationSnapshotSchema.parse(await host.snapshot()).rows
            .window,
        ).toEqual(completed.rows.window);
        expect(await readScope(host)).toEqual(context.scopeBefore);
        expect(model.requests).toHaveLength(2);
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 完成消息、原文件链接、真实文件读取与FileManager装配公开边界。
  },
);
