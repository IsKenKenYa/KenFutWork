// @vitest-environment node
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  activateCommandButton,
  enterCommandQuery,
  commandSearchInput as input,
  openCommandCenter,
} from "./setup/code-command-center-public.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { withTaskGroupPublicPage } from "./setup/code-task-groups-public.fixture.js";

const dialog = '[role="dialog"]';
const retry = "重新搜索";
const title = "会话搜索验证甲乙";
const older = "验证甲乙";
const unmatched = "不匹配的会话丙丁";

const searchRpc = z.object({
  service: z.literal("window-controller"),
  method: z.literal("listTaskList"),
  args: z.tuple([z.object({ search: z.string() })]),
});

async function observeSearchTransport(page: OriginalSessionBrowser) {
  const {
    cdp,
    target: { sessionId },
  } = page;
  const pending: Promise<unknown>[] = [];
  const completed = new Set<string>();
  const responses: { query: string; status: number }[] = [];
  let failInitial = true;
  let failed = false;
  let held: { requestId: string; networkId: string } | undefined;
  const send = (method: string, params: Record<string, unknown>) => {
    const result = cdp.send(method, params, sessionId);
    pending.push(result);
    void result.catch(() => undefined);
    return result;
  };
  const offFinished = cdp.on("Network.loadingFinished", (event, sid) => {
    if (sid === sessionId && typeof event.requestId === "string")
      completed.add(event.requestId);
  });
  const offPaused = cdp.on("Fetch.requestPaused", (event, sid) => {
    if (sid !== sessionId || typeof event.requestId !== "string") return;
    const requestId = event.requestId;
    const status = event.responseStatusCode;
    const atResponse =
      typeof status === "number" ||
      typeof event.responseErrorReason === "string";
    const { postData } = z
      .object({ postData: z.string().optional() })
      .parse(event.request);
    const rpc = postData ? searchRpc.safeParse(JSON.parse(postData)) : null;
    if (rpc?.success) {
      const query = rpc.data.args[0].search;
      if (!atResponse && query === title && failInitial) {
        failInitial = false;
        failed = true;
        void send("Fetch.failRequest", {
          requestId,
          errorReason: "ConnectionReset",
        });
        return;
      }
      if (typeof status === "number") {
        responses.push({ query, status });
        if (query === older && !held) {
          held = { requestId, networkId: z.string().parse(event.networkId) };
          return;
        }
      }
    }
    void send(atResponse ? "Fetch.continueResponse" : "Fetch.continueRequest", {
      requestId,
    });
  });
  await cdp.send(
    "Fetch.enable",
    {
      patterns: ["Request", "Response"].map((requestStage) => ({
        urlPattern: "*/api/code-ui/rpc",
        requestStage,
      })),
    },
    sessionId,
  );
  let released = false;
  return {
    get failed() {
      return failed;
    },
    responses,
    async waitForOlder() {
      const response = await vi.waitFor(() => {
        if (!held) throw new Error("旧搜索的响应尚未到达");
        return held;
      });
      const payload = z
        .object({ body: z.string(), base64Encoded: z.boolean().optional() })
        .parse(
          await send("Fetch.getResponseBody", {
            requestId: response.requestId,
          }),
        );
      const { result } = z
        .object({
          result: z.object({ items: z.array(z.object({ title: z.string() })) }),
        })
        .parse(
          JSON.parse(
            payload.base64Encoded
              ? Buffer.from(payload.body, "base64").toString("utf8")
              : payload.body,
          ),
        );
      expect(result.items).toContainEqual({ title });
    },
    async releaseOlder() {
      if (!held) throw new Error("未取得旧搜索的真实响应");
      const { requestId, networkId } = held;
      await send("Fetch.continueResponse", { requestId });
      released = true;
      await vi.waitFor(() => expect(completed.has(networkId)).toBe(true));
    },
    async close() {
      try {
        if (held && !released)
          await send("Fetch.continueResponse", { requestId: held.requestId });
        await cdp.send("Fetch.disable", {}, sessionId);
        await Promise.all(pending);
      } finally {
        offFinished();
        offPaused();
      }
    },
  };
}

async function enterSearch(page: OriginalSessionBrowser, query: string) {
  await enterCommandQuery(page, `#${query}`);
}

function searchState(page: OriginalSessionBrowser) {
  return page.evaluate<{
    alert: string | null;
    noResults: boolean;
    result: boolean;
    inputFocused: boolean;
  }>(`(() => {
    const panel = document.querySelector(${JSON.stringify(dialog)});
    const field = panel.querySelector(${JSON.stringify(input)});
    return {
      alert: panel.querySelector('[role="alert"]')?.textContent.trim() ?? null,
      noResults: panel.textContent.includes('暂无相关结果'),
      result: [...panel.querySelectorAll('[role="option"]')].some(
        node => node.textContent.includes(${JSON.stringify(title)})),
      inputFocused: document.activeElement === field,
    };
  })()`);
}

async function expectSearchState(
  page: OriginalSessionBrowser,
  state: Partial<Awaited<ReturnType<typeof searchState>>>,
) {
  await vi.waitFor(async () =>
    expect(await searchState(page)).toMatchObject(state),
  );
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "会话搜索失败可重试且不让旧查询覆盖当前结果",
  async () => {
    await withTaskGroupPublicPage(
      async ({ host, page, model }) => {
        expect((await host.command("renameSession", { title })).status).toBe(
          200,
        );
        const expected = await host.client.request("/api/code-ui/rpc", {
          service: "window-controller",
          method: "listTaskList",
          args: [
            {
              kind: "active",
              workspaceScopes: [{ workspacePath: host.workspacePath }],
              sortBy: "updated",
              search: title,
            },
          ],
        });
        expect(expected.status).toBe(200);
        expect(expected.body.result.items).toContainEqual(
          expect.objectContaining({ title, taskId: host.sessionId }),
        );
        await openCommandCenter(page);
        const transport = await observeSearchTransport(page);
        try {
          await enterSearch(page, title);
          await vi.waitFor(() => expect(transport.failed).toBe(true));
          await expectSearchState(page, {
            alert: "任务搜索失败",
            noResults: false,
            inputFocused: true,
          });
          await activateCommandButton(page, retry);
          await expectSearchState(page, {
            alert: null,
            result: true,
            inputFocused: true,
          });
          expect(transport.responses).toContainEqual({
            query: title,
            status: 200,
          });

          await enterSearch(page, older);
          await transport.waitForOlder();
          expect(await searchState(page)).toMatchObject({
            result: false,
            noResults: false,
          });
          await enterSearch(page, unmatched);
          await expectSearchState(page, {
            alert: null,
            noResults: true,
            result: false,
          });
          await transport.releaseOlder();
          await page.evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          expect(await searchState(page)).toMatchObject({
            alert: null,
            noResults: true,
            result: false,
          });
          expect(transport.responses).toContainEqual({
            query: unmatched,
            status: 200,
          });
          expect(model.requests).toHaveLength(1);
        } finally {
          await transport.close();
        }
      },
      { seedTaskHistory: true, prepareTaskContent: false },
    );
  },
  120_000,
);
