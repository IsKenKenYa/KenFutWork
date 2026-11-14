// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  codeTaskGroupSaveArgsSchema,
  codeTaskGroupSaveResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  dismissGroupSetup,
  expectContentPreserved,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const createSelector = '[data-testid="sidebar"] button[aria-label="新建分组"]';
const requestFactSchema = z.object({
  requestId: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  state: z.string(),
});
type PausedGroupResponse = {
  networkId: string | null;
  method: string;
  status: number | null;
  error: string | null;
  held: boolean;
};

async function waitForCreateButton(page: OriginalSessionBrowser) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(createSelector)});
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility === "visible",
          disabled: button.disabled,
          hit: Boolean(hit && button.contains(hit)),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ visible: true, disabled: false, hit: true }),
  );
}

function readRpc(request: unknown) {
  const postData = z
    .object({ postData: z.string().optional() })
    .parse(request).postData;
  if (!postData) return null;
  return z
    .object({ service: z.string(), method: z.string() })
    .parse(JSON.parse(postData));
}

/** 只暂停原Root读取的真实响应，原状态码和响应正文保持不变。 */
async function withHeldGroupReads(
  page: OriginalSessionBrowser,
  work: (pending: {
    waitForRead(): Promise<void>;
    release(): Promise<void>;
    responses(): readonly PausedGroupResponse[];
  }) => Promise<void>,
) {
  let holding = true;
  const held = new Map<string, number>();
  const continuations: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const responses: PausedGroupResponse[] = [];
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
  const release = async () => {
    holding = false;
    const ids = [...held.keys()];
    held.clear();
    await Promise.all(ids.map(continueResponse));
  };
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const rpc = readRpc(params.request);
      const hold =
        holding && rpc?.service === "task-groups" && rpc.method === "read";
      if (rpc?.service === "task-groups")
        responses.push({
          networkId:
            typeof params.networkId === "string" ? params.networkId : null,
          method: rpc.method,
          status:
            typeof params.responseStatusCode === "number"
              ? params.responseStatusCode
              : null,
          error:
            typeof params.responseErrorReason === "string"
              ? params.responseErrorReason
              : null,
          held: hold,
        });
      if (hold) {
        held.set(params.requestId, z.number().parse(params.responseStatusCode));
        return;
      }
    } catch (error) {
      failures.push(error);
    }
    void continueResponse(params.requestId);
  });
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
    await work({
      async waitForRead() {
        await vi.waitFor(() => {
          expect(failures).toEqual([]);
          expect(held.size).toBeGreaterThan(0);
          for (const status of held.values()) expect(status).toBe(200);
        });
      },
      release,
      responses: () => responses,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      release,
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
  }
  if (failures.length)
    throw new AggregateError(failures, "原分组读取等待或清理失败", {
      cause: failures[0],
    });
}

async function readResponse(page: OriginalSessionBrowser, requestId: string) {
  const response = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      ),
    );
  return JSON.parse(
    response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body,
  );
}

async function readSave(
  page: OriginalSessionBrowser,
  previous: ReadonlySet<string>,
  count: number,
  responses: () => readonly PausedGroupResponse[],
) {
  const request = await vi.waitFor(() => {
    const saves = z
      .array(requestFactSchema)
      .parse(page.requests)
      .filter(
        (entry) =>
          !previous.has(entry.requestId) &&
          entry.service === "task-groups" &&
          entry.method === "save",
      );
    const diagnostics = JSON.stringify({
      saveAttempt: count,
      saves,
      pauses: responses(),
      pageErrors: page.pageErrors,
    });
    expect(saves, diagnostics).toHaveLength(count);
    const found = saves[count - 1];
    if (!found) throw new Error("原新建按钮缺少实际保存请求。");
    expect(found.state, diagnostics).toBe("finished");
    return found;
  });
  const post = z
    .object({ postData: z.string() })
    .parse(
      await page.cdp.send(
        "Network.getRequestPostData",
        { requestId: request.requestId },
        page.target.sessionId,
      ),
    );
  const [input] = codeTaskGroupSaveArgsSchema.parse(
    z.object({ args: z.unknown() }).parse(JSON.parse(post.postData)).args,
  );
  if (!("creationId" in input)) throw new Error("原新建按钮发出了编辑请求。");
  return {
    input,
    status: request.status,
    body: await readResponse(page, request.requestId),
  };
}

async function createFromOtherConnection(
  { host }: TaskGroupPublicPageContext,
  expectedRevision: number,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "save",
    args: [
      {
        creationId: randomUUID(),
        expectedRevision,
        title: "另一可信连接创建的分组",
      },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupSaveResponseSchema.parse(response.body).result;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组创建冲突后的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("确定冲突后再次明确新建使用新创建身份和当前修订，保留原任务与内容", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const { host, page, model, scopeBefore, snapshotBefore } = context;
        await waitForCreateButton(page);
        const before = await readGroups(host);
        expect(before.groups).toEqual([]);
        const previous = new Set(
          z
            .array(requestFactSchema)
            .parse(page.requests)
            .map((request) => request.requestId),
        );
        await withHeldGroupReads(page, async (pending) => {
          const remote = await createFromOtherConnection(
            context,
            before.revision,
          );
          const advanced = await readGroups(host);
          expect(advanced).toMatchObject({
            revision: before.revision + 1,
            groups: [remote],
          });
          await pending.waitForRead();
          expect(
            await page.evaluate(
              `document.querySelectorAll('[data-task-group-id=${JSON.stringify(remote.id)}]').length`,
            ),
          ).toBe(0);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: createSelector,
          });
          const conflict = await readSave(page, previous, 1, pending.responses);
          expect(conflict.input.expectedRevision).toBe(before.revision);
          expect(conflict.status).toBe(409);
          expect(
            applicationErrorResponseSchema.parse(conflict.body).error.code,
          ).toBe("task_group_revision_conflict");
          expect(await readGroups(host)).toEqual(advanced);
          await expectContentPreserved(context);
          await pending.release();
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelectorAll('[data-task-group-id=${JSON.stringify(remote.id)}]').length`,
              ),
            ).toBe(1),
          );
          await waitForCreateButton(page);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: createSelector,
          });
          const retried = await readSave(page, previous, 2, pending.responses);
          expect(retried.input.creationId).not.toBe(conflict.input.creationId);
          expect(retried.input.expectedRevision).toBe(advanced.revision);
          expect(retried.status).toBe(200);
          const created = codeTaskGroupSaveResponseSchema.parse(
            retried.body,
          ).result;
          expect(created.id).not.toBe(remote.id);
          const after = await readGroups(host);
          expect(after.revision).toBe(advanced.revision + 1);
          expect(after.groups).toHaveLength(2);
          expect(new Set(after.groups.map((group) => group.id))).toEqual(
            new Set([remote.id, created.id]),
          );
          expect(after.members).toEqual(advanced.members);
          await dismissGroupSetup(page);
          await expectContentPreserved(context);
        });
        expect(await readScope(host)).toEqual(scopeBefore);
        const original = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(original.rows.window).toEqual(snapshotBefore.rows.window);
        expect(original.taskControl).toEqual(snapshotBefore.taskControl);
        expect(model.requests).toEqual([]);
      });
    }, 180_000); // 原Root、独占浏览器、双连接冲突与HTTP/SSE/临时PG关闭期限。
  },
);
