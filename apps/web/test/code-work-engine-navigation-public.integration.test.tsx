// @vitest-environment node
import { expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

async function expectSharedTask(
  { page, host, draft }: TaskGroupPublicPageContext,
  view: "chat" | "work",
) {
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`(() => {
        const shell = document.querySelector('[data-workspace-main-view]');
        const input = shell?.querySelector('[role="textbox"][contenteditable="true"]');
        return {
          view: shell?.getAttribute('data-workspace-main-view'),
          sameInput: Boolean(input && input === window.__taskGroupPublicBefore.input),
          draft: input?.textContent,
          task: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          inert: Boolean(input?.closest('[inert]')),
          visible: input?.checkVisibility(),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      view,
      sameInput: true,
      draft,
      task: host.sessionId,
      inert: view === "work",
      visible: view === "chat",
    });
  });
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Work 引擎往返保留共享会话和原 Task",
  async () => {
    await withTaskGroupPublicPage(
      async (context) => {
        const { page, host } = context;
        const click = (selector: string) =>
          clickOn(page.cdp, page.target.sessionId, { selector });
        await clickExactText(page, '[role="radio"]', "Work");
        await expectSharedTask(context, "chat");
        const open = '[data-testid="work-engine-sidebar-open"]';
        const back = 'button[aria-label="返回会话"]';
        for (let round = 0; round < 2; round++) {
          await click(open);
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(back)})?.checkVisibility()`,
              ),
            ).toBe(true),
          );
          await expectSharedTask(context, "work");
          if (round === 0) await click(back);
          else await clickExactText(page, '[role="radio"]', "Code");
          await expectSharedTask(context, "chat");
          expect(
            await page.evaluate(
              `document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim()`,
            ),
          ).toBe(round === 0 ? "Work" : "Code");
        }
        expect(await readScope(host)).toEqual(context.scopeBefore);
        expect(context.model.requests).toHaveLength(
          context.modelRequestCountBefore,
        );
      },
      { seedTaskHistory: true, enableWork: true },
    );
  },
  180_000,
);
