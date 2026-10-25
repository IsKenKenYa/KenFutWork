// @vitest-environment node
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原文件管理器的Root、文件、HTTP与PostgreSQL integration",
  () => {
    it("Task目录打开原FileManager标签，页内预览保留当前会话、草稿和权限", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host, draft, previewTitle } = context;
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
          {
            type: "mouseMoved",
            ...point,
          },
          page.target.sessionId,
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: `${row} button[aria-label="显示文件树"]`,
        });
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
  },
);
