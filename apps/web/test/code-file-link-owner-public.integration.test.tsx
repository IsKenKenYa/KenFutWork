// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  codeUiViewerScopeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import { observeViewerRequests } from "./setup/code-file-viewer-public.fixture.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const fileInputSchema = z.object({
  path: z.string(),
  viewerScope: codeUiViewerScopeSchema,
});

async function readSnapshot(
  context: TaskGroupPublicPageContext,
  taskId: string,
) {
  const response = await context.host.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function createOtherTask(context: TaskGroupPublicPageContext) {
  const { host, model } = context;
  const created = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: host.projectId,
          config: {
            modelSelection: context.snapshotBefore.config.modelSelection,
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const taskId = z.uuid().parse(created.body.result.result.sessionId);
  const initial = await readSnapshot(context, taskId);
  if (!initial.taskControl) throw new Error("真实B任务缺少控制观察值。");
  const sent = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: taskId,
        type: "sendText",
        payload: { text: "文件等待期间切换到的B任务" },
        taskControl: initial.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(sent.status).toBe(200);
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  model.finish(1);
  const readCompleted = async () => {
    const current = await readSnapshot(context, taskId);
    expect(current.control.phase).toBe("completedSuccess");
    return current;
  };
  const complete = await vi.waitFor(readCompleted, { timeout: 30_000 });
  const read = await host.client.request(`/api/code-ui/tasks/${taskId}/scope`);
  expect(read.status).toBe(200);
  return {
    taskId,
    snapshot: complete,
    scope: codeTaskScopeResponseSchema.parse(read.body).scope,
  };
}

async function holdStatReply(page: OriginalSessionBrowser, path: string) {
  type Held = {
    requestId: string;
    networkId: string;
    status: number;
    input: z.infer<typeof fileInputSchema>;
  };
  let held: Held | undefined;
  let finished = false;
  let released = false;
  const failures: unknown[] = [];
  const operations: Promise<unknown>[] = [];
  const send = (method: string, params: Record<string, unknown>) => {
    const operation = page.cdp.send(method, params, page.target.sessionId);
    operations.push(operation);
    void operation.catch((error: unknown) => failures.push(error));
    return operation;
  };
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const request = z
        .object({ postData: z.string().optional() })
        .parse(params.request);
      const rpc = request.postData
        ? z
            .object({
              service: z.string(),
              method: z.string(),
              args: z.array(z.unknown()),
            })
            .parse(JSON.parse(request.postData))
        : null;
      if (!held && rpc?.service === "file" && rpc.method === "stat") {
        const input = fileInputSchema.parse(rpc.args[0]);
        if (input.path === path) {
          held = {
            requestId: params.requestId,
            networkId: z.string().parse(params.networkId),
            status: z.number().parse(params.responseStatusCode),
            input,
          };
          return;
        }
      }
    } catch (error) {
      failures.push(error);
    }
    void send("Fetch.continueResponse", { requestId: params.requestId });
  });
  const offFinished = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        params.requestId === held?.networkId
      )
        finished = true;
    },
  );
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/code-ui/rpc", requestStage: "Response" }],
  });
  return {
    async wait() {
      const readHeld = () => {
        if (failures.length) throw new AggregateError(failures);
        expect(held).not.toBeUndefined();
        if (!held) throw new Error("尚未取得原文件stat响应。");
        return held;
      };
      return vi.waitFor(readHeld, { timeout: 5_000 });
    },
    async readBody() {
      if (!held) throw new Error("原文件stat响应未暂停。");
      return send("Fetch.getResponseBody", { requestId: held.requestId });
    },
    async release() {
      if (!held) throw new Error("原文件stat响应未暂停。");
      await send("Fetch.continueResponse", { requestId: held.requestId });
      released = true;
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5_000 });
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    },
    async close() {
      if (held && !released)
        await send("Fetch.continueResponse", { requestId: held.requestId });
      offPaused();
      offFinished();
      await send("Fetch.disable", {});
      await Promise.allSettled(operations);
      if (failures.length)
        throw new AggregateError(failures, "原文件响应控制失败");
    },
  };
}

async function selectTask(page: OriginalSessionBrowser, taskId: string) {
  const selector = `[data-testid=${JSON.stringify(`task-item-${taskId}`)}]`;
  const point = await vi.waitFor(async () => {
    const value = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const row = document.querySelector(${JSON.stringify(selector)});
      if (!row) return null;
      row.scrollIntoView({block:'center'});
      await new Promise(requestAnimationFrame);
      const rect = row.getBoundingClientRect();
      const x = rect.left + rect.width * 0.4, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && row.contains(hit) && !hit.closest('button') ? {x,y} : null;
    })()`);
    expect(value, JSON.stringify(page.pageErrors)).not.toBeNull();
    return value;
  });
  if (!point) throw new Error("B任务行未显示。");
  await clickOn(page.cdp, page.target.sessionId, point);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id')`,
      ),
    ).toBe(taskId),
  );
}

async function contentState(page: OriginalSessionBrowser) {
  return page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const tab = document.querySelector('[data-side-pane-tab-id][data-state=active]');
    return { taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      draft: input?.textContent, activeTab: tab?.getAttribute('data-side-pane-tab-id') ?? null };
  })()`);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原消息文件等待与Task归属 integration",
  () => {
    it("A文件stat等待期间切换B，原响应不打开B内容或借用B文件权限", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host, model, fixture } = context;
        const directory = join(fixture.directory, "仅A授权的文件目录");
        await mkdir(directory);
        const path = join(directory, "delayed-owner.svg");
        await writeFile(
          path,
          '<svg xmlns="http://www.w3.org/2000/svg" width="37" height="17"/>',
        );
        const granted = await host.client.request(
          `/api/code-ui/tasks/${host.sessionId}/scope`,
          {
            additionalDirectories: [{ path: directory, access: "read-only" }],
          },
          "PATCH",
        );
        expect(granted.status, JSON.stringify(granted.body)).toBe(200);
        const scopeA = codeTaskScopeResponseSchema.parse(granted.body).scope;
        const other = await createOtherTask(context);
        const denied = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          args: [{ path, viewerScope: { kind: "task", taskId: other.taskId } }],
        });
        expect(denied.status).toBe(404);
        expect(
          (await host.command("sendText", { text: "显示A任务文件链接" }))
            .status,
        ).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        model.writeText(2, `[延迟打开A任务文件](${path})`);
        model.finish(2);
        const readCompleted = async () =>
          expect(
            (await readSnapshot(context, host.sessionId)).control.phase,
          ).toBe("completedSuccess");
        await vi.waitFor(readCompleted, { timeout: 30_000 });
        const observation = observeViewerRequests(page);
        const gate = await holdStatReply(page, path);
        try {
          await clickExactText(
            page,
            "[data-session-id] button, [data-session-id] a",
            "延迟打开A任务文件",
          );
          const held = await gate.wait();
          expect(held.status).toBe(200);
          expect(held.input.viewerScope).toEqual({
            kind: "task",
            taskId: host.sessionId,
          });
          const body = await gate.readBody();
          await selectTask(page, other.taskId);
          const before = await contentState(page);
          expect(await gate.readBody()).toEqual(body);
          await gate.release();
          expect(await contentState(page)).toEqual(before);
          const borrowed = [...observation.requests.values()].filter(
            (request) => {
              if (request.service !== "file") return false;
              const input = fileInputSchema.safeParse(request.args[0]);
              return (
                input.success &&
                input.data.path === path &&
                input.data.viewerScope.kind === "task" &&
                input.data.viewerScope.taskId === other.taskId
              );
            },
          );
          expect(borrowed).toEqual([]);
          expect(await readScope(host)).toEqual(scopeA);
          const scopeB = await host.client.request(
            `/api/code-ui/tasks/${other.taskId}/scope`,
          );
          expect(codeTaskScopeResponseSchema.parse(scopeB.body).scope).toEqual(
            other.scope,
          );
          expect(model.requests).toHaveLength(3);
          expect(
            (await readSnapshot(context, other.taskId)).rows.window,
          ).toEqual(other.snapshot.rows.window);
          await selectTask(page, host.sessionId);
          await clickExactText(
            page,
            "[data-session-id] button, [data-session-id] a",
            "延迟打开A任务文件",
          );
          const readImage = async () =>
            expect(
              await page.evaluate(`(() => {
            const pane = Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility());
            return pane?.querySelector('[data-testid="preview-pane"] img')?.naturalWidth;
          })()`),
            ).toBe(37);
          await vi.waitFor(readImage, { timeout: 5_000 });
          expect(await readScope(host)).toEqual(scopeA);
          expect(model.requests).toHaveLength(3);
        } finally {
          observation.dispose();
          await gate.close();
        }
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 两个真实Task、原消息点击、原始stat回包、独占浏览器和全部资源关闭期限。
  },
);
