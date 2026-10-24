// @vitest-environment node
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import {
  createGroupFromUi,
  expectContentPreserved,
  readGroups,
  readScope,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组界面的原Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("通过原侧栏创建持久分组，当前Task、草稿、文件内容和授权保持", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const before = await readGroups(context.host);
        expect(before.groups).toEqual([]);
        const created = await createGroupFromUi(context);
        expect(created.title).toBe("新分组");
        expect(
          await context.page.evaluate(
            `Boolean(document.querySelector('button[aria-label="收起全部分组"]')?.checkVisibility())`,
          ),
        ).toBe(true);
        await expectContentPreserved(context);
        expect(await readScope(context.host)).toEqual(context.scopeBefore);
        const after = protocol.conversationSnapshotSchema.parse(
          await context.host.snapshot(),
        );
        expect(after.rows.window).toEqual(context.snapshotBefore.rows.window);
        expect(context.model.requests).toEqual([]);
      });
    }, 180_000); // 原Root生产构建、独占浏览器、HTTP/SSE及临时PG的完整关闭期限。
  },
);
