// @vitest-environment node
import {
  applicationErrorResponseSchema,
  codeTaskGroupSchema,
  codeUiRpcResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import { selectAll } from "./setup/code-public-browser-actions.js";
import {
  createGroupFromUi,
  dismissGroupSetup,
  expectContentPreserved,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const requestFactSchema = z.object({
  requestId: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  state: z.string(),
});

function titleInput(groupId: string) {
  return `[data-task-group-id=${JSON.stringify(groupId)}] [data-testid="task-group-title-input"]`;
}

async function enterRename(
  { page }: TaskGroupPublicPageContext,
  groupId: string,
) {
  const selector = `[data-grouped-group-header-id=${JSON.stringify(groupId)}]`;
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(async () => {
        const header = document.querySelector(${JSON.stringify(selector)});
        if (!header) return null;
        header.scrollIntoView({ block: "center" });
        await new Promise(requestAnimationFrame);
        const rect = header.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && header.contains(hit) ? { x, y } : null;
      })()`,
    );
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原分组标题尚未显示。");
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  const renameSelector = '[data-testid="task-group-rename"]';
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(renameSelector)})?.checkVisibility())`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: renameSelector,
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(titleInput(groupId))})?.checkVisibility())`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
}

async function enterTitle(
  { page }: TaskGroupPublicPageContext,
  groupId: string,
  text: string,
) {
  const selector = titleInput(groupId);
  await clickOn(page.cdp, page.target.sessionId, { selector });
  await selectAll(page);
  await typeText(page.cdp, page.target.sessionId, text);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.value`,
      ),
    ).toBe(text),
  );
}

async function expectTitleAndDraft(
  { page }: TaskGroupPublicPageContext,
  groupId: string,
  title: string,
  draft: string,
) {
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`(() => {
          const group = document.querySelector('[data-task-group-id=${JSON.stringify(groupId)}]');
          const input = group?.querySelector('[data-testid="task-group-title-input"]');
          return { title: group?.getAttribute('data-task-group-title'), draft: input?.value };
        })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({ title, draft });
    },
    { timeout: 5_000 },
  ); // 等待原SSE接纳远端名称，当前名称输入保持。
}

async function expectConflictResponse(
  { page }: TaskGroupPublicPageContext,
  previousRequests: ReadonlySet<string>,
) {
  const response = await vi.waitFor(
    async () => {
      const requests = z.array(requestFactSchema).parse(page.requests);
      const conflicts = requests.filter(
        (request) =>
          !previousRequests.has(request.requestId) &&
          request.service === "task-groups" &&
          request.method === "save" &&
          request.status === 409 &&
          request.state === "finished",
      );
      expect(conflicts, JSON.stringify(page.pageErrors)).toHaveLength(1);
      const conflict = conflicts[0];
      if (!conflict) throw new Error("原名称提交缺少实际冲突回执。");
      return conflict;
    },
    { timeout: 5_000 },
  ); // 仅观察原Enter实际发出的HTTP请求，不代发保存。
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
  expect(applicationErrorResponseSchema.parse(body).error.code).toBe(
    "task_group_revision_conflict",
  );
}

async function renameFromOtherConnection(
  { host }: TaskGroupPublicPageContext,
  id: string,
  expectedRevision: number,
  title: string,
) {
  const remote = await host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "save",
    args: [{ id, expectedRevision, title }],
  });
  expect(remote.status, JSON.stringify(remote.body)).toBe(200);
  return codeTaskGroupSchema.parse(
    codeUiRpcResponseSchema.parse(remote.body).result,
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组名称编辑与冲突的Root、HTTP、SSE和PostgreSQL integration",
  () => {
    it("原菜单保存Unicode名称，另一连接更新后旧编辑返回409且保留名称草稿与当前内容", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const { page, host, model, snapshotBefore, scopeBefore } = context;
        const group = await createGroupFromUi(context);
        await dismissGroupSetup(page);
        const before = await readGroups(host);
        const title = "研究分组 🧭 Alpha 中文";
        await enterRename(context, group.id);
        await enterTitle(context, group.id, title);
        await pressKey(page.cdp, page.target.sessionId, "Enter");
        const named = await vi.waitFor(
          async () => {
            const current = await readGroups(host);
            expect(current.revision).toBe(before.revision + 1);
            expect(current.groups).toHaveLength(1);
            expect(current.groups[0]).toMatchObject({
              id: group.id,
              title,
              color: group.color,
              createdAt: group.createdAt,
            });
            return current;
          },
          { timeout: 5_000 },
        ); // 原改名菜单、Enter及实际持久保存的等待期限。
        expect(named.members).toEqual(before.members);
        expect(named.order).toEqual(before.order);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelector('[data-task-group-id=${JSON.stringify(group.id)}]')?.getAttribute('data-task-group-title')`,
            ),
          ).toBe(title),
        );
        const draft = "尚未提交的名称草稿 🌿 Beta";
        await enterRename(context, group.id);
        await enterTitle(context, group.id, draft);
        const remoteTitle = "另一可信连接保存的名称";
        const remoteGroup = await renameFromOtherConnection(
          context,
          group.id,
          named.revision,
          remoteTitle,
        );
        expect(remoteGroup).toMatchObject({ id: group.id, title: remoteTitle });
        const changed = await readGroups(host);
        expect(changed).toEqual({
          ...named,
          revision: named.revision + 1,
          groups: [remoteGroup],
        });
        await expectTitleAndDraft(context, group.id, remoteTitle, draft);
        await clickOn(page.cdp, page.target.sessionId, {
          selector: titleInput(group.id),
        });
        const previousRequests = new Set(
          z
            .array(requestFactSchema)
            .parse(page.requests)
            .map((request) => request.requestId),
        );
        await pressKey(page.cdp, page.target.sessionId, "Enter");
        await expectConflictResponse(context, previousRequests);
        await expectTitleAndDraft(context, group.id, remoteTitle, draft);
        expect(await readGroups(host)).toEqual(changed);
        await expectContentPreserved(context);
        expect(await readScope(host)).toEqual(scopeBefore);
        const original = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(original.rows.window).toEqual(snapshotBefore.rows.window);
        expect(original.taskControl).toEqual(snapshotBefore.taskControl);
        expect(model.requests).toEqual([]);
      });
    }, 180_000); // 原Root、独占浏览器、实际双连接保存与HTTP/SSE/临时PG关闭期限。
  },
);
