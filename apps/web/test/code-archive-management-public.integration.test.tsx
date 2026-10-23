// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import type { PublicFixture } from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Scope = ReturnType<typeof codeTaskScopeResponseSchema.parse>["scope"];
const inputSelector = '[role="textbox"][contenteditable="true"]';
const archivedTitle = "归档管理恢复公开任务";
const draft = "归档管理期间保留的当前草稿";
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function snapshot(host: Host, taskId: string) {
  const response = await host.client.request(`/api/code-ui/sessions/${taskId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function scope(host: Host, taskId: string) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function readTree(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [
      { hostId: "local", includeDeleted: false, includeDeletedTasks: true },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function taskCommand(
  host: Host,
  type: "sendText" | "stop",
  payload: { text: string } | Record<string, never>,
) {
  const current = await snapshot(host, host.sessionId);
  if (!current.taskControl) throw new Error("归档材料缺少公开Task观察值。");
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: host.sessionId,
        type,
        payload,
        taskControl: current.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
}

async function expectArchivedTask(host: Host) {
  await vi.waitFor(async () => {
    const tree = await readTree(host);
    expect(tree.tasks).toContainEqual(
      expect.objectContaining({
        taskId: host.sessionId,
        projectId: host.projectId,
        title: archivedTitle,
        archived: true,
      }),
    );
    expect(tree.deletedTasks).not.toContainEqual(
      expect.objectContaining({ taskId: host.sessionId }),
    );
  });
}

async function archiveStoppedTask(
  host: Host,
  stopped: protocol.ConversationSnapshot,
) {
  if (!stopped.taskControl) throw new Error("已停止Task缺少公开控制观察值。");
  const archived = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "archiveTask",
    args: [
      {
        taskId: host.sessionId,
        workspacePath: host.workspacePath,
        workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
        taskControl: stopped.taskControl,
      },
    ],
  });
  expect(archived.status, JSON.stringify(archived.body)).toBe(200);
  await expectArchivedTask(host);
}

async function prepareArchivedTask(host: Host, model: Model) {
  const readOnly = join(host.workspacePath, "归档参考资料");
  const readWrite = join(host.workspacePath, "归档输出目录");
  await mkdir(readOnly);
  await mkdir(readWrite);
  const changed = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    {
      additionalDirectories: [
        { path: readOnly, access: "read-only" },
        { path: readWrite, access: "read-write" },
      ],
    },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const before = await scope(host, host.sessionId);
  expect(before.additionalDirectories).toEqual([
    { path: readOnly, access: "read-only" },
    { path: readWrite, access: "read-write" },
  ]);
  await taskCommand(host, "sendText", { text: archivedTitle });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例独占HTTP模型流，不属于Agent运行时配置。
  await taskCommand(host, "stop", {});
  const stopped = await vi.waitFor(
    async () => {
      const current = await snapshot(host, host.sessionId);
      expect(current.control.phase).toBe("completedInterrupted");
      expect(current.meta.title).toBe(archivedTitle);
      expect(model.requests[0]?.closed).toBe(true);
      return current;
    },
    { timeout: 30_000 },
  );
  await archiveStoppedTask(host, stopped);
  return { before, modelSelection: stopped.config.modelSelection };
}

async function createCurrentTask(
  host: Host,
  modelSelection: protocol.SessionConfigState["modelSelection"],
) {
  const response = await host.stream.rpc("sendConversationCommandV4", [
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
          config: { modelSelection, mode: "build", planEnabled: false },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("当前Task的公开创建回执缺少会话身份。");
  expect(ack.result.sessionId).not.toBe(host.sessionId);
  return ack.result.sessionId;
}

async function expectCurrentTask(
  page: OriginalSessionBrowser,
  taskId: string,
  text: string,
) {
  await vi.waitFor(async () => {
    const current = await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      return {
        taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
        draft: input?.textContent,
      };
    })()`);
    expect(current, JSON.stringify(page.pageErrors)).toEqual({
      taskId,
      draft: text,
    });
  });
}

function archiveGroupSelector(host: Host) {
  return `[data-testid="archive-management"] [data-testid="archive-group"][data-project-id=${JSON.stringify(host.projectId)}][data-host-id="local"]`;
}

function archiveTaskSelector(host: Host) {
  return `${archiveGroupSelector(host)} [data-testid="archive-task"][data-task-id=${JSON.stringify(host.sessionId)}]`;
}

async function restoreThroughOriginalSettings(
  page: OriginalSessionBrowser,
  host: Host,
  projectName: string,
) {
  await clickOn(page.cdp, page.target.sessionId, {
    selector:
      '[data-root-workspace-surface="interactive"] [data-testid="task-settings-button"]',
  });
  await clickExactText(
    page,
    '[data-testid="settings-section-nav-archives"]',
    "归档管理",
  );
  const groupSelector = archiveGroupSelector(host);
  await vi.waitFor(async () => {
    const group = await page.evaluate<{
      count: number;
      expanded: string | null;
      taskCount: number;
      name: string | null;
      title: string | null;
    }>(`(() => {
      const group = document.querySelector(${JSON.stringify(groupSelector)});
      return {
        count: document.querySelectorAll(${JSON.stringify(groupSelector)}).length,
        expanded: group?.querySelector('[data-testid="archive-group-toggle"]')?.getAttribute('aria-expanded') ?? null,
        taskCount: group?.querySelectorAll('[data-testid="archive-task"]').length ?? 0,
        name: group?.querySelector('[data-testid="archive-group-toggle"]')?.textContent?.trim() ?? null,
        title: document.querySelector('[data-testid="archive-management"] h2')?.textContent ?? null,
      };
    })()`);
    expect(group, JSON.stringify(page.pageErrors)).toEqual({
      count: 1,
      expanded: "false",
      taskCount: 0,
      name: projectName,
      title: "已归档的会话",
    });
  });
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${groupSelector} [data-testid="archive-group-toggle"]`,
  });
  const taskSelector = archiveTaskSelector(host);
  await vi.waitFor(async () => {
    const task = await page.evaluate(`(() => {
      const task = document.querySelector(${JSON.stringify(taskSelector)});
      return {
        count: document.querySelectorAll(${JSON.stringify(taskSelector)}).length,
        title: task?.querySelector('p[title]')?.getAttribute('title') ?? null,
        restoreEnabled: Boolean(task?.querySelector('[data-testid="archive-unarchive"]:enabled')),
      };
    })()`);
    expect(task, JSON.stringify(page.pageErrors)).toEqual({
      count: 1,
      title: archivedTitle,
      restoreEnabled: true,
    });
  });
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${taskSelector} [data-testid="archive-unarchive"]`,
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelectorAll(${JSON.stringify(taskSelector)}).length`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(0),
  );
}

async function expectRestoredTask(host: Host, before: Scope) {
  await vi.waitFor(async () => {
    const tree = await readTree(host);
    expect(tree.tasks).toContainEqual(
      expect.objectContaining({
        taskId: host.sessionId,
        projectId: host.projectId,
        hostId: "local",
        workspacePath: before.rootDirectory,
        workspaceIdentity: JSON.stringify([
          host.projectId,
          before.rootDirectory,
        ]),
        title: archivedTitle,
        pinned: false,
        archived: false,
      }),
    );
  });
  expect(await scope(host, host.sessionId)).toMatchObject({
    instanceId: before.instanceId,
    taskId: host.sessionId,
    projectId: host.projectId,
    rootDirectory: before.rootDirectory,
    additionalDirectories: before.additionalDirectories,
    sandboxMode: before.sandboxMode,
  });
  const restored = await snapshot(host, host.sessionId);
  expect(restored.rows.window).toContainEqual(
    expect.objectContaining({
      kind: "userInput",
      text: archivedTitle,
    }),
  );
}

async function showArchivedTaskForDeletion(
  page: OriginalSessionBrowser,
  host: Host,
) {
  const groupSelector = archiveGroupSelector(host);
  const expanded = await vi.waitFor(async () => {
    const state = await page.evaluate<{
      count: number;
      expanded: string | null;
    }>(
      `(() => {
        const group = document.querySelector(${JSON.stringify(groupSelector)});
        return {
          count: document.querySelectorAll(${JSON.stringify(groupSelector)}).length,
          expanded: group?.querySelector('[data-testid="archive-group-toggle"]')?.getAttribute('aria-expanded') ?? null,
        };
      })()`,
    );
    expect(state.count, JSON.stringify(page.pageErrors)).toBe(1);
    return state.expanded;
  });
  if (expanded === "false")
    await clickOn(page.cdp, page.target.sessionId, {
      selector: `${groupSelector} [data-testid="archive-group-toggle"]`,
    });
  else expect(expanded).toBe("true");
  await vi.waitFor(async () => {
    const enabled = await page.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(`${archiveTaskSelector(host)} [data-testid="archive-delete"]:enabled`)}))`,
    );
    expect(enabled, JSON.stringify(page.pageErrors)).toBe(true);
  });
}

async function chooseArchiveDeletion(
  page: OriginalSessionBrowser,
  host: Host,
  choice: "取消" | "删除",
) {
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${archiveTaskSelector(host)} [data-testid="archive-delete"]`,
  });
  const dialogSelector = '[role="dialog"][data-state="open"]';
  await vi.waitFor(async () => {
    const dialog = await page.evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
      return {
        count: document.querySelectorAll(${JSON.stringify(dialogSelector)}).length,
        title: dialog?.querySelector('h2')?.textContent ?? null,
        description: dialog?.querySelector('p')?.textContent ?? null,
      };
    })()`);
    expect(dialog, JSON.stringify(page.pageErrors)).toEqual({
      count: 1,
      title: "删除这 1 个归档会话？",
      description: "删除后无法恢复",
    });
  });
  await clickExactText(page, `${dialogSelector} button > span`, choice);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.querySelectorAll('[role=dialog]').length"),
      JSON.stringify(page.pageErrors),
    ).toBe(0),
  );
}

async function deleteThroughOriginalSettings(
  page: OriginalSessionBrowser,
  host: Host,
  model: Model,
  requestsBefore: number,
) {
  await archiveStoppedTask(host, await snapshot(host, host.sessionId));
  await showArchivedTaskForDeletion(page, host);
  await chooseArchiveDeletion(page, host, "取消");
  await expectArchivedTask(host);
  expect(model.requests).toHaveLength(requestsBefore);
  await showArchivedTaskForDeletion(page, host);
  await chooseArchiveDeletion(page, host, "删除");
  await vi.waitFor(async () => {
    const tree = await readTree(host);
    expect(tree.tasks).not.toContainEqual(
      expect.objectContaining({ taskId: host.sessionId }),
    );
    expect(tree.deletedTasks).toContainEqual({
      taskId: host.sessionId,
      projectId: host.projectId,
      hostId: "local",
    });
    for (const path of [
      `/api/code-ui/sessions/${host.sessionId}`,
      `/api/code-ui/tasks/${host.sessionId}/scope`,
    ]) {
      const missing = await host.client.request(path);
      expect(missing.status, JSON.stringify(missing.body)).toBe(404);
    }
    expect(
      await page.evaluate(
        `document.querySelectorAll(${JSON.stringify(archiveTaskSelector(host))}).length`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(0);
  });
  expect(model.requests).toHaveLength(requestsBefore);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原归档管理的原Root公共 integration",
  () => {
    it("原设置恢复与确认删除归档任务，保留固定工作域、当前Task和草稿", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture & { origin: string }>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const archived = await prepareArchivedTask(host, model);
        const currentTaskId = await createCurrentTask(
          host,
          archived.modelSelection,
        );
        const currentScope = await scope(host, currentTaskId);
        const listed = await host.client.request("/api/code-ui/rpc", {
          service: "project",
          method: "readProjects",
          args: [{ hostId: "local" }],
        });
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const project = codeProjectEditorProjectSchema
          .array()
          .parse(listed.body.result)
          .find((entry) => entry.id === host?.projectId);
        if (!project) throw new Error("公开项目列表缺少原归档Task的项目。");
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: currentTaskId,
          clientId: host.clientId,
          workspaceShell: true,
        });
        await expectCurrentTask(browser, currentTaskId, "");
        await clickOn(browser.cdp, browser.target.sessionId, {
          selector: inputSelector,
        });
        await typeText(browser.cdp, browser.target.sessionId, draft);
        await expectCurrentTask(browser, currentTaskId, draft);
        expect(model.requests).toHaveLength(1);
        const requestsBefore = model.requests.length;
        await restoreThroughOriginalSettings(browser, host, project.name);
        await expectRestoredTask(host, archived.before);
        expect(await scope(host, currentTaskId)).toEqual(currentScope);
        expect(model.requests).toHaveLength(requestsBefore);
        await deleteThroughOriginalSettings(
          browser,
          host,
          model,
          requestsBefore,
        );
        expect(await scope(host, currentTaskId)).toEqual(currentScope);
        await clickOn(browser.cdp, browser.target.sessionId, {
          selector: '[data-testid="settings-back-button"]',
        });
        await expectCurrentTask(browser, currentTaskId, draft);
        expect((await snapshot(host, currentTaskId)).sessionId).toBe(
          currentTaskId,
        );
        expect(await scope(host, currentTaskId)).toEqual(currentScope);
        expect(model.requests).toHaveLength(requestsBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原归档管理验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000); // 原组件生产装配、独占Chrome和临时PG的测试期限。
  },
);
