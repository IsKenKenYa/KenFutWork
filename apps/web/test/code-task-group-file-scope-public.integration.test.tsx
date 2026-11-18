// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import {
  expectContentPreserved,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const viewerArgumentSchema = z.object({
  path: z.string().optional(),
  workspacePath: z.string().optional(),
  paths: z.array(z.string()).optional(),
  viewerScope: codeUiViewerScopeSchema.optional(),
});
async function readyPoint(page: OriginalSessionBrowser, selector: string) {
  return vi.waitFor(async () => {
    const point = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.checkVisibility());
      if (!element || element.disabled) return null;
      element.scrollIntoView({ block: "center" });
      const panel = element.closest('[aria-hidden]');
      if (panel) await Promise.all(panel.getAnimations().map(animation => animation.finished));
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element.checkVisibility() && hit && element.contains(hit)
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
    })()`);
    expect(point, JSON.stringify(page.pageErrors)).not.toBeNull();
    if (!point) throw new Error("原分组文件入口尚未显示。");
    return point;
  });
}

async function openGroupedTaskFiles(
  page: OriginalSessionBrowser,
  taskId: string,
) {
  const row = `[data-testid=${JSON.stringify(`task-item-${taskId}`)}]`;
  const point = await readyPoint(page, row);
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...point },
    page.target.sessionId,
  );
  const button = await readyPoint(
    page,
    `${row} button[aria-label="显示文件树"]`,
  );
  await clickOn(page.cdp, page.target.sessionId, button);
}

async function expectViewerRequest(
  observation: ReturnType<typeof observeViewerRequests>,
  target: {
    service?: "file" | "git";
    method: string;
    path: string;
    taskId: string;
    includedPath?: string;
  },
) {
  await vi.waitFor(
    () => {
      const requests = [...observation.requests.values()].filter((request) => {
        if (
          request.service !== (target.service ?? "file") ||
          request.method !== target.method
        )
          return false;
        const input = viewerArgumentSchema.parse(request.args[0]);
        return (
          (input.path ?? input.workspacePath) === target.path &&
          input.viewerScope?.kind === "task" &&
          input.viewerScope.taskId === target.taskId
        );
      });
      expect(
        requests,
        JSON.stringify([...observation.requests.values()]),
      ).not.toHaveLength(0);
      for (const request of requests) {
        const input = viewerArgumentSchema.parse(request.args[0]);
        expect(input.viewerScope).toEqual({
          kind: "task",
          taskId: target.taskId,
        });
        if (target.includedPath !== undefined)
          expect(input.paths).toContain(target.includedPath);
        expect(request.status).toBe(200);
      }
    },
    { timeout: 5_000 },
  ); // 等待当前原组件实际文件请求及HTTP回包，不重试业务操作。
}

function expectObservedTaskScope(
  observation: ReturnType<typeof observeViewerRequests>,
  target: { taskId: string; file: string },
) {
  for (const request of observation.requests.values()) {
    const raw = request.args[0];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const input = viewerArgumentSchema.parse(raw);
    const path = input.path ?? input.workspacePath;
    if (path === target.file)
      expect(input.viewerScope).toEqual({
        kind: "task",
        taskId: target.taskId,
      });
  }
}

async function expectCurrentTaskPreserved({
  page,
  host,
  draft,
}: TaskGroupPublicPageContext) {
  expect(
    await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      return {
        sameInput: Boolean(input && input === window.__taskGroupPublicBefore.input),
        taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
        draft: input?.textContent,
      };
    })()`),
  ).toEqual({ sameInput: true, taskId: host.sessionId, draft });
}

async function openFilePreview(
  page: OriginalSessionBrowser,
  path: string,
  title: string,
) {
  const point = await readyPoint(
    page,
    `[data-testid=${JSON.stringify(`workspace-file-tree-row-${path}`)}]`,
  );
  await clickOn(page.cdp, page.target.sessionId, point);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
        const image = document.querySelector('[data-testid="preview-pane"] img[alt=${JSON.stringify(title)}]');
        return {
          title: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
          imageReady: Boolean(image && image.complete && image.naturalWidth > 0),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ title, imageReady: true }),
  );
}

async function expectIndependentFileRights(
  context: TaskGroupPublicPageContext,
  target: { taskId: string; path: string; content: string },
) {
  const read = (taskId: string) =>
    context.host.client.request("/api/code-ui/rpc", {
      service: "file",
      method: "readTextFile",
      args: [{ path: target.path, viewerScope: { kind: "task", taskId } }],
    });
  const denied = await read(context.host.sessionId);
  expect(denied.status, JSON.stringify(denied.body)).toBe(404);
  const allowed = await read(target.taskId);
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  expect(allowed.body.result.content).toBe(target.content);
}

async function taskSnapshot(
  context: TaskGroupPublicPageContext,
  taskId: string,
) {
  const response = await context.host.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function taskScope(context: TaskGroupPublicPageContext, taskId: string) {
  const response = await context.host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function createOtherTask(context: TaskGroupPublicPageContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "code-ui-group-file-b-")),
  );
  const dispose = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const { projectId, workspacePath } = context.host;
    const created = await context.host.stream.rpc("sendConversationCommandV4", [
      {
        workspacePath,
        projectId,
        envelope: {
          commandId: randomUUID(),
          clientId: context.host.clientId,
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: projectId,
            config: {
              modelSelection: context.snapshotBefore.config.modelSelection,
            },
          },
          issuedAt: Date.now(),
        },
      },
    ]);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(protocol.commandAckSchema.parse(created.body.result).status).toBe(
      "accepted",
    );
    const taskId = z.uuid().parse(created.body.result.result.sessionId);
    const grant = await context.host.client.request(
      `/api/code-ui/tasks/${taskId}/scope`,
      { additionalDirectories: [{ path: directory, access: "read-only" }] },
      "PATCH",
    );
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(codeTaskScopeResponseSchema.parse(grant.body).scope).toMatchObject({
      taskId,
      projectId,
      rootDirectory: workspacePath,
      additionalDirectories: [{ path: directory, access: "read-only" }],
    });
    return { taskId, projectId, workspacePath, directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function seedOtherTaskHistory(
  context: TaskGroupPublicPageContext,
  other: Awaited<ReturnType<typeof createOtherTask>>,
) {
  const before = await taskSnapshot(context, other.taskId);
  if (!before.taskControl) throw new Error("B任务缺少公开操作版本。");
  const index = context.model.requests.length;
  expect(index).toBe(context.modelRequestCountBefore);
  const sent = await context.host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: other.workspacePath,
      projectId: other.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: context.host.clientId,
        sessionId: other.taskId,
        type: "sendText",
        payload: { text: "B任务文件权限验收" },
        taskControl: before.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(
    () => expect(context.model.requests).toHaveLength(index + 1),
    {
      timeout: 30_000,
    },
  ); // 仅等待B真实首发到达现有本机模型HTTP服务。
  context.model.finish(index);
  await vi.waitFor(
    async () => {
      const snapshot = await taskSnapshot(context, other.taskId);
      expect(snapshot.control.phase).toBe("completedSuccess");
      expect(
        snapshot.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
      ).toEqual(["B任务文件权限验收"]);
      expect(context.model.requests[index]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  ); // B完成后才验证目录展示及文件读取，保留全部模型请求证据。
  return index + 1;
}

async function verifyTaskFileScope(context: TaskGroupPublicPageContext) {
  const other = await createOtherTask(context);
  try {
    const modelRequestCountBefore = await seedOtherTaskHistory(context, other);
    const title = "B任务专属预览.svg";
    const path = join(other.workspacePath, title);
    const original = join(other.directory, title);
    const content =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><title>B任务专属文件</title></svg>';
    await writeFile(original, content, "utf8");
    await symlink(original, path);
    const otherScope = await taskScope(context, other.taskId);
    expect(otherScope.rootDirectory).toBe(other.workspacePath);
    expect(otherScope.taskId).not.toBe(context.scopeBefore.taskId);
    expect(otherScope.additionalDirectories).toEqual([
      { path: other.directory, access: "read-only" },
    ]);
    expect(context.scopeBefore.additionalDirectories).toEqual([]);
    await expectIndependentFileRights(context, {
      taskId: other.taskId,
      path,
      content,
    });
    const observation = observeViewerRequests(context.page);
    try {
      await expectCurrentTaskPreserved(context);
      await expectContentPreserved(context);
      await openGroupedTaskFiles(context.page, other.taskId);
      await expectCurrentTaskPreserved(context);
      expect(
        await context.page.evaluate(`(() => {
        const before = window.__taskGroupPublicBefore;
        const active = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
        return { previewRetained: before.preview.isConnected, tabRetained: before.tab.isConnected,
          newTabActive: active !== before.tab, fileManager: Boolean(document.querySelector('[data-file-manager-pane]')) };
      })()`),
      ).toEqual({
        previewRetained: true,
        tabRetained: true,
        newTabActive: true,
        fileManager: true,
      });
      await expectViewerRequest(observation, {
        method: "readdir",
        path: other.workspacePath,
        taskId: other.taskId,
      });
      await openFilePreview(context.page, path, title);
      await expectViewerRequest(observation, {
        method: "readTextFile",
        path,
        taskId: other.taskId,
      });
      expectObservedTaskScope(observation, {
        taskId: other.taskId,
        file: path,
      });
      await expectCurrentTaskPreserved(context);
      expect(await readScope(context.host)).toEqual(context.scopeBefore);
      expect(await taskScope(context, other.taskId)).toEqual(otherScope);
      const after = protocol.conversationSnapshotSchema.parse(
        await context.host.snapshot(),
      );
      expect(after.rows.window).toEqual(context.snapshotBefore.rows.window);
      expect(context.model.requests).toHaveLength(modelRequestCountBefore);
      await expectViewerRequest(observation, {
        service: "git",
        method: "getIgnoredPaths",
        path: other.workspacePath,
        taskId: other.taskId,
        includedPath: path,
      });
    } finally {
      observation.dispose();
    }
  } finally {
    await other.dispose();
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组文件入口的Task身份、HTTP、SSE与PostgreSQL integration",
  () => {
    it("当前Task为A时从B行打开文件，以B权限读取并保留A会话与草稿", async () => {
      await withTaskGroupPublicPage(verifyTaskFileScope, {
        seedTaskHistory: true,
      });
    }, 180_000); // 原Root、真实双Task、独占Chrome和临时PG的关闭期限。
  },
);
