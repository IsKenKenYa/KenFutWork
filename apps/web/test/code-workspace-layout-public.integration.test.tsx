// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  readScope,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

async function conversationRatio(page: OriginalSessionBrowser) {
  return page.evaluate<number | null>(`(() => {
    const conversation = document.getElementById('conversation-column');
    const content = document.getElementById('browser');
    if (!conversation || !content) return null;
    const left = conversation.getBoundingClientRect().width;
    const right = content.getBoundingClientRect().width;
    return left > 0 && right > 0 ? left / (left + right) : null;
  })()`);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原工作台会话宽度与真实文件内容 integration",
  () => {
    it("未保存宽度时Code会话占52%，原草稿和Task目录保持", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          await vi.waitFor(async () =>
            expect(
              await conversationRatio(context.page),
              JSON.stringify(context.page.pageErrors),
            ).toBeCloseTo(0.52, 2),
          );
          expect(
            await context.page.evaluate(`(() => {
          const input = document.querySelector('[role="textbox"][contenteditable="true"]');
          return { same: input === window.__taskGroupPublicBefore.input, draft: input?.textContent };
        })()`),
          ).toEqual({ same: true, draft: context.draft });
          expect(await readScope(context.host)).toEqual(context.scopeBefore);
          expect(context.model.requests).toHaveLength(
            context.modelRequestCountBefore,
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root生产构建、实际布局、独占Chrome、真实HTTP/SSE及临时PostgreSQL。
  },
);
