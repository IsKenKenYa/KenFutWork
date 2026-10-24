// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  canonicalLocalWorkspaceIdentity,
  parseLocalWorkspaceIdentity,
} from "../../../packages/zcode-shared/dist/index.js";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import {
  type ProjectionContext,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

type TaskTarget = {
  projectId: string;
  workspacePath: string;
  workspaceIdentity: string;
  taskId: string;
  title: string;
};
const inputSelector = '[role="textbox"][contenteditable="true"]';
const requestFactSchema = z.object({
  requestId: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  state: z.string(),
});

async function readTree({ session }: ProjectionContext) {
  const response = await session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function snapshot(context: ProjectionContext, taskId: string) {
  const response = await context.session.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function scope(context: ProjectionContext, taskId: string) {
  const response = await context.session.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function withColdBrowser<T>(
  context: ProjectionContext,
  work: (page: OriginalSessionBrowser) => Promise<T>,
) {
  const { fixture, session } = context;
  const page = await openOriginalSessionBrowser({
    backendBaseUrl: fixture.baseUrl,
    backendOrigin: fixture.origin,
    accessToken: await fixture.app.kernel.get("localAccess").getDesktopToken(),
    workspacePath: session.workspacePath,
    projectId: session.projectId,
    sessionId: session.sessionId,
    clientId: session.clientId,
    workspaceShell: true,
    restoreSession: true,
    beforeNavigate: async ({ cdp, target }) => {
      await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(JSON.stringify({ view: "projects", order: [], expanded: {} }))});`,
        },
        target.sessionId,
      );
    },
  });
  const failures: unknown[] = [];
  let visibleFailure: string | undefined;
  let result: T | undefined;
  try {
    result = await work(page);
  } catch (error) {
    failures.push(error);
    try {
      visibleFailure = JSON.stringify(
        await page.evaluate(`({
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).filter(node => node.checkVisibility()).map(node => node.textContent),
        text: document.body.innerText.slice(-2000),
        sessions: Array.from(document.querySelectorAll('[data-session-id]')).map(node => node.getAttribute('data-session-id')),
        composerCount: document.querySelectorAll(${JSON.stringify(inputSelector)}).length,
      })`),
      );
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  } finally {
    try {
      await page.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      visibleFailure
        ? `冷恢复浏览器验证或关闭失败：${visibleFailure}`
        : "冷恢复浏览器验证或关闭失败",
      { cause: failures[0] },
    );
  return result;
}

async function stopTask(
  context: ProjectionContext,
  projectId: string,
  workspacePath: string,
  taskId: string,
) {
  const current = await snapshot(context, taskId);
  if (!current.taskControl) throw new Error("新Task缺少真实控制观察值。");
  const stopped = await context.session.stream.rpc(
    "sendConversationCommandV4",
    [
      {
        workspacePath,
        projectId,
        envelope: {
          commandId: randomUUID(),
          clientId: context.session.clientId,
          sessionId: taskId,
          type: "stop",
          payload: {},
          taskControl: current.taskControl,
          issuedAt: Date.now(),
        },
      },
    ],
  );
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
}

async function createTask(
  context: ProjectionContext,
  projectId: string,
  workspacePath: string,
  title: string,
  stop: boolean,
): Promise<TaskTarget> {
  const { session, model } = context;
  const modelIndex = model.requests.length;
  const original = protocol.conversationSnapshotSchema.parse(
    await session.snapshot(),
  );
  const response = await session.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath,
      projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: session.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: projectId,
          firstInput: { text: title },
          config: { modelSelection: original.config.modelSelection },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("缺少真实Task创建回执。");
  const taskId = z.uuid().parse(ack.result.sessionId);
  await vi.waitFor(() => expect(model.requests).toHaveLength(modelIndex + 1), {
    timeout: 30_000,
  });
  if (stop) await stopTask(context, projectId, workspacePath, taskId);
  else model.finish(modelIndex);
  await vi.waitFor(
    async () => {
      const current = await snapshot(context, taskId);
      expect(current.control.phase).toBe(
        stop ? "completedInterrupted" : "completedSuccess",
      );
      expect(current.meta.title).toBe(title);
      expect(model.requests[modelIndex]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  ); // 仅等待本例真实模型HTTP结束与持久会话投影。
  return {
    projectId,
    workspacePath,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(
      projectId,
      workspacePath,
    ),
    taskId,
    title,
  };
}

async function expectTaskRow(page: OriginalSessionBrowser, target: TaskTarget) {
  const selector = `section[data-project-id=${JSON.stringify(target.projectId)}] [data-testid=${JSON.stringify(`task-item-${target.taskId}`)}]`;
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(row => ({
        projectId: row.closest('section[data-project-id]')?.getAttribute('data-project-id'), text: row.textContent,
      }))`),
        JSON.stringify(page.pageErrors),
      ).toEqual([
        {
          projectId: target.projectId,
          text: expect.stringContaining(target.title),
        },
      ]);
    },
    { timeout: 30_000 },
  ); // 等待原项目树收到真实Task通知并显示对应项目行。
}

async function clickTask(page: OriginalSessionBrowser, target: TaskTarget) {
  await expectTaskRow(page, target);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `[data-testid=${JSON.stringify(`task-item-${target.taskId}`)}]`,
  });
  try {
    await vi.waitFor(
      async () => {
        expect(
          await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      const session = input?.closest('[data-session-id]');
      return { id: session?.getAttribute('data-session-id'), text: session?.innerText };
    })()`),
          JSON.stringify(page.pageErrors),
        ).toEqual({
          id: target.taskId,
          text: expect.stringContaining(target.title),
        });
      },
      { timeout: 30_000 },
    ); // 冷会话切换经真实订阅和完整快照就绪后再读取正文。
  } catch (error) {
    const commands = [];
    for (const request of z.array(requestFactSchema).parse(page.requests)) {
      if (
        request.method !== "sendConversationCommandV4" ||
        request.status !== 501
      )
        continue;
      const post = await page.cdp.send(
        "Network.getRequestPostData",
        { requestId: request.requestId },
        page.target.sessionId,
      );
      const body = z.object({ postData: z.string() }).parse(post);
      const input = z
        .object({
          args: z.tuple([
            z.object({
              projectId: z.string().optional(),
              workspaceIdentity: z.string().optional(),
              envelope: z.object({
                type: z.string(),
                sessionId: z.string().nullable(),
              }),
            }),
          ]),
        })
        .parse(JSON.parse(body.postData)).args[0];
      commands.push(input);
    }
    const visible = await page.evaluate(`({
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).filter(node => node.checkVisibility()).map(node => node.textContent),
      sessions: Array.from(document.querySelectorAll('[data-session-id]')).map(node => node.getAttribute('data-session-id')),
      text: document.body.innerText.slice(-1500),
    })`);
    throw new AggregateError(
      [error],
      `原Task切换未就绪：${JSON.stringify({ commands, visible })}`,
    );
  }
}

async function expectActiveProject(page: OriginalSessionBrowser, name: string) {
  await vi.waitFor(
    async () => {
      const labels = await page.evaluate<
        string[]
      >(`Array.from(document.querySelectorAll('[data-testid="composer-workspace-trigger"], [data-testid="workspace-path"]'))
      .filter(node => node.checkVisibility() && !node.closest('[hidden], [inert], [aria-hidden="true"]'))
      .map(node => node.getAttribute('data-testid') === 'workspace-path' ? node.getAttribute('aria-label') ?? '' : node.textContent ?? '')`);
      expect(labels.length, JSON.stringify(page.pageErrors)).toBeGreaterThan(0);
      for (const label of labels) expect(label).toContain(name);
    },
    { timeout: 30_000 },
  ); // 草稿项目菜单与已有Task的目录标题分别显示当前Project。
}

async function expectPublicReadsWithoutNewRun(
  context: ProjectionContext,
  page: OriginalSessionBrowser,
) {
  const facts = z.array(requestFactSchema).parse(page.requests);
  expect(facts).toContainEqual(
    expect.objectContaining({
      service: "project",
      method: "readTree",
      state: "finished",
      status: 200,
    }),
  );
  for (const request of facts) {
    if (
      request.method !== "sendConversationCommandV4" ||
      request.state !== "finished"
    )
      continue;
    const post = z
      .object({ postData: z.string() })
      .parse(
        await page.cdp.send(
          "Network.getRequestPostData",
          { requestId: request.requestId },
          page.target.sessionId,
        ),
      );
    const input = z
      .object({ args: z.tuple([z.object({ envelope: z.unknown() })]) })
      .parse(JSON.parse(post.postData));
    const parsed = protocol.parseCommandEnvelope(input.args[0].envelope);
    if (!parsed.ok) throw parsed.error;
    if (parsed.envelope.type === "createSession")
      expect(
        protocol.commandPayloadSchemas.createSession.parse(
          parsed.envelope.payload,
        ).firstInput,
      ).toBeUndefined();
  }
  for (const response of page.sessionCreateAcks) {
    const ack = z
      .object({ result: protocol.commandAckSchema })
      .parse(response).result;
    if (ack.result?.type !== "createSession")
      throw new Error("预热缺少真实创建回执。");
    const current = await context.session.client.request(
      `/api/code-ui/sessions/${ack.result.sessionId}`,
    );
    expect([200, 404]).toContain(current.status);
    if (current.status === 200) {
      const state = protocol.conversationSnapshotSchema.parse(
        current.body.snapshot,
      );
      expect(state.control.phase).toBe("draft");
      expect(state.rows.window).toEqual([]);
    }
  }
}

async function expectUnchangedTask(
  context: ProjectionContext,
  target: TaskTarget,
  before: protocol.ConversationSnapshot,
  permissions: Awaited<ReturnType<typeof scope>>,
) {
  const after = await snapshot(context, target.taskId);
  expect(after.control).toEqual(before.control);
  expect(after.revision).toBe(before.revision);
  expect(after.taskControl).toEqual(before.taskControl);
  expect(after.rows).toEqual(before.rows);
  expect(await scope(context, target.taskId)).toEqual(permissions);
}

async function addReadOnlyDirectory(
  context: ProjectionContext,
  target: TaskTarget,
) {
  const directory = join(
    context.fixture.directory,
    `冷恢复参考目录-${target.taskId}`,
  );
  await mkdir(directory);
  const response = await context.session.client.request(
    `/api/code-ui/tasks/${target.taskId}/scope`,
    { additionalDirectories: [{ path: directory, access: "read-only" }] },
    "PATCH",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const permissions = codeTaskScopeResponseSchema.parse(response.body).scope;
  expect(permissions).toMatchObject({
    projectId: target.projectId,
    taskId: target.taskId,
    rootDirectory: target.workspacePath,
    additionalDirectories: [{ path: directory, access: "read-only" }],
  });
  return permissions;
}

async function createSameRootProject(context: ProjectionContext, name: string) {
  const root = context.session.workspacePath;
  const response = await context.session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "saveProject",
    args: [
      {
        creationId: randomUUID(),
        kind: "code",
        name,
        roots: [root],
        primaryRoot: root,
        rootPermissions: {},
        directoryChoice: "independent",
      },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.parse(response.body.result);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Root冷恢复的HTTP、SSE、真实PostgreSQL与独占浏览器integration",
  () => {
    it("无选项目创建停止默认Task，冷恢复仍显示原Task及qualified目录且不重新运行", async () => {
      await withProjectionResources(async (context) => {
        await context.client.services.settingService.update({
          lastWorkspaceSession: [],
          lastActiveTabIndex: 0,
          lastActiveTaskByWorkspace: {},
        });
        const prepared = await withColdBrowser(context, async (page) => {
          expect(
            z.array(requestFactSchema).parse(page.requests),
          ).toContainEqual(
            expect.objectContaining({
              service: "file",
              method: "ensureConversationWorkspace",
              status: 200,
            }),
          );
          const workspace =
            await context.client.services.fileService.ensureConversationWorkspace();
          const identity = parseLocalWorkspaceIdentity(
            workspace.workspaceIdentity,
            workspace.path,
          );
          if (!identity) throw new Error("真实默认目录缺少本机项目身份。");
          expect(identity.projectId).not.toBe(context.session.projectId);
          const target = await createTask(
            context,
            identity.projectId,
            workspace.path,
            "默认恢复Task",
            true,
          );
          const permissions = await addReadOnlyDirectory(context, target);
          await clickTask(page, target);
          await vi.waitFor(async () => {
            const saved = await context.client.services.settingService.get();
            expect(saved.lastWorkspaceSession).toEqual([
              {
                kind: "local",
                workspacePath: target.workspacePath,
                workspaceIdentity: target.workspaceIdentity,
                workspacePurpose: "conversation",
              },
            ]);
          });
          return {
            target,
            permissions,
            before: await snapshot(context, target.taskId),
          };
        });
        if (!prepared) throw new Error("默认Task准备未完成。");
        const { target: task, permissions, before } = prepared;
        const treeBefore = await readTree(context);
        const modelRequests = context.model.requests.length;
        await withColdBrowser(context, async (page) => {
          await expectTaskRow(page, task);
          await expectActiveProject(page, "默认对话");
          await clickTask(page, task);
          await expectPublicReadsWithoutNewRun(context, page);
          expect(await readTree(context)).toEqual(treeBefore);
          expect(context.model.requests).toHaveLength(modelRequests);
        });
        await expectUnchangedTask(context, task, before, permissions);
      });
    }, 240_000); // 两次独占原Root构建、真实创建停止及全部资源关闭期限。

    it("同目录两Project冷恢复各自Task及tab焦点，双向选择保持身份、目录和权限", async () => {
      await withProjectionResources(async (context) => {
        const first = await createSameRootProject(context, "同根项目A");
        const second = await createSameRootProject(context, "同根项目B");
        expect(first.id).not.toBe(second.id);
        expect(first.roots).toEqual(second.roots);
        const root = context.session.workspacePath;
        const firstTask = await createTask(
          context,
          first.id,
          root,
          "同根项目A独立Task",
          false,
        );
        const secondTask = await createTask(
          context,
          second.id,
          root,
          "同根项目B独立Task",
          false,
        );
        const firstScope = await addReadOnlyDirectory(context, firstTask);
        const secondScope = await scope(context, secondTask.taskId);
        expect(secondScope.additionalDirectories).toEqual([]);
        const saved = {
          lastWorkspaceSession: [firstTask, secondTask].map((task) => ({
            kind: "local" as const,
            workspacePath: root,
            workspaceIdentity: task.workspaceIdentity,
            workspacePurpose: "project" as const,
          })),
          lastActiveTabIndex: 1,
          lastActiveTaskByWorkspace: {
            [firstTask.workspaceIdentity]: firstTask.taskId,
            [secondTask.workspaceIdentity]: secondTask.taskId,
          },
        };
        await context.client.services.settingService.update(saved);
        const firstBefore = await snapshot(context, firstTask.taskId);
        const secondBefore = await snapshot(context, secondTask.taskId);
        const treeBefore = await readTree(context);
        const modelRequests = context.model.requests.length;
        await withColdBrowser(context, async (page) => {
          await expectTaskRow(page, firstTask);
          await expectTaskRow(page, secondTask);
          await expectActiveProject(page, second.name);
          expect(
            await page.evaluate(
              `document.querySelector('section[data-project-id="${first.id}"] [data-testid="task-item-${secondTask.taskId}"]') !== null`,
            ),
          ).toBe(false);
          expect(
            await page.evaluate(
              `document.querySelector('section[data-project-id="${second.id}"] [data-testid="task-item-${firstTask.taskId}"]') !== null`,
            ),
          ).toBe(false);
          expect(
            await context.client.services.settingService.get(),
          ).toMatchObject(saved);
          await clickTask(page, firstTask);
          await vi.waitFor(async () =>
            expect(
              (await context.client.services.settingService.get())
                .lastActiveTabIndex,
            ).toBe(0),
          );
          await clickTask(page, secondTask);
          await expectActiveProject(page, second.name);
          await vi.waitFor(
            async () =>
              expect(
                await context.client.services.settingService.get(),
              ).toMatchObject(saved),
            { timeout: 30_000 },
          );
          expect(
            await page.evaluate(
              'Array.from(document.querySelectorAll("button")).some(button => button.checkVisibility() && button.textContent.trim() === "重连")',
            ),
          ).toBe(false);
          await expectPublicReadsWithoutNewRun(context, page);
          expect(await readTree(context)).toEqual(treeBefore);
          expect(context.model.requests).toHaveLength(modelRequests);
        });
        await expectUnchangedTask(context, firstTask, firstBefore, firstScope);
        await expectUnchangedTask(
          context,
          secondTask,
          secondBefore,
          secondScope,
        );
      });
    }, 180_000); // 同目录真实Task、原组件冷恢复、双向切换与PG关闭期限。
  },
);
