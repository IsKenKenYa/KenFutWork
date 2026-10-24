// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeProjectPreparedSession,
  codeProjectEditorProjectSchema,
  codeProjectPreparedSessionResponseSchema,
  codeProjectPrepareSessionArgsSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectListResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalLocalWorkspaceIdentity } from "../../../packages/zcode-shared/dist/index.js";
import {
  clickOn,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { selectAll } from "./setup/code-public-browser-actions.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const workspaceTrigger = '[data-testid="composer-workspace-trigger"]';
const requestFactSchema = z.object({
  requestId: z.string(),
  path: z.string(),
  service: z.string().optional(),
  method: z.string().optional(),
  state: z.string(),
  status: z.number().optional(),
});
const commandRequestSchema = z.object({
  args: z.tuple([
    z.object({
      workspacePath: z.string(),
      workspaceIdentity: z.string().optional(),
      projectId: z.uuid().optional(),
      envelope: protocol.commandEnvelopeSchema,
    }),
  ]),
});
type HeldProjectPreparation = {
  requestId: string;
  networkId: string;
  status: number;
};

function requestFacts(page: OriginalSessionBrowser) {
  return z.array(requestFactSchema).parse(page.requests);
}

function readRpc(request: unknown) {
  const { postData } = z
    .object({ postData: z.string().optional() })
    .parse(request);
  if (!postData) return null;
  return z
    .object({
      service: z.string(),
      method: z.string(),
      args: z.array(z.unknown()),
    })
    .parse(JSON.parse(postData));
}

async function readResponseBody(
  page: OriginalSessionBrowser,
  method: "Fetch.getResponseBody" | "Network.getResponseBody",
  requestId: string,
) {
  const response = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(await page.cdp.send(method, { requestId }, page.target.sessionId));
  return response.base64Encoded
    ? Buffer.from(response.body, "base64").toString("utf8")
    : response.body;
}

async function continuePreparedResponse(
  page: OriginalSessionBrowser,
  response: HeldProjectPreparation,
  originalBody: string,
  failures: readonly unknown[],
  continueResponse: (requestId: string) => Promise<unknown>,
) {
  const beforeRelease = new Set(
    requestFacts(page).map((request) => request.requestId),
  );
  await continueResponse(response.requestId);
  await vi.waitFor(
    () => {
      expect(failures).toEqual([]);
      const requests = requestFacts(page);
      expect(
        requests.find((request) => request.requestId === response.networkId),
      ).toMatchObject({ state: "finished", status: 200 });
      expect(
        requests.filter(
          (request) =>
            !beforeRelease.has(request.requestId) &&
            request.path === "/api/code-ui/workspaces" &&
            request.state === "finished" &&
            request.status === 200,
        ).length,
      ).toBeGreaterThan(0);
    },
    { timeout: 15_000 },
  ); // 等待原响应及其触发的真实目录刷新完成。
  expect(
    await readResponseBody(page, "Network.getResponseBody", response.networkId),
  ).toBe(originalBody);
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
  );
}

/** 暂停浏览器所选项目的真实准备响应，读取并原样继续服务器返回字节。 */
async function withHeldProjectPreparation(
  page: OriginalSessionBrowser,
  projectIds: readonly string[],
  work: (pending: {
    waitForPrepared(projectId: string): Promise<CodeProjectPreparedSession>;
    expectPending(projectId: string): void;
    release(projectId: string): Promise<void>;
  }) => Promise<void>,
) {
  const expectedIds = new Set(projectIds);
  const held = new Map<string, HeldProjectPreparation>();
  const originalBodies = new Map<string, string>();
  const released = new Set<string>();
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
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
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const rpc = readRpc(params.request);
      if (rpc?.service === "project" && rpc.method === "prepareSession") {
        const { projectId } = codeProjectPrepareSessionArgsSchema.parse(
          rpc.args,
        )[0];
        if (expectedIds.has(projectId) && !held.has(projectId)) {
          held.set(projectId, {
            requestId: params.requestId,
            networkId: z.string().parse(params.networkId),
            status: z.number().parse(params.responseStatusCode),
          });
          return;
        }
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
      async waitForPrepared(projectId) {
        const response = await vi.waitFor(() => {
          expect(failures).toEqual([]);
          const found = held.get(projectId);
          expect(found).toMatchObject({ status: 200 });
          if (!found) throw new Error("原项目准备响应尚未到达。");
          return found;
        });
        const originalBody = await readResponseBody(
          page,
          "Fetch.getResponseBody",
          response.requestId,
        );
        originalBodies.set(projectId, originalBody);
        return codeProjectPreparedSessionResponseSchema.parse(
          JSON.parse(originalBody),
        ).result;
      },
      expectPending(projectId) {
        const response = held.get(projectId);
        expect(response).toMatchObject({ status: 200 });
        expect(released.has(projectId)).toBe(false);
        expect(
          requestFacts(page).find(
            (request) => request.requestId === response?.networkId,
          ),
        ).toMatchObject({ state: "pending" });
      },
      async release(projectId) {
        const response = held.get(projectId);
        const originalBody = originalBodies.get(projectId);
        if (!response || originalBody === undefined)
          throw new Error("原项目准备响应尚未核验。");
        released.add(projectId);
        await continuePreparedResponse(
          page,
          response,
          originalBody,
          failures,
          continueResponse,
        );
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      () =>
        Promise.all(
          [...held]
            .filter(([projectId]) => !released.has(projectId))
            .map(([, response]) => continueResponse(response.requestId)),
        ),
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
    throw new AggregateError(failures, "原项目准备响应等待或清理失败", {
      cause: failures[0],
    });
}

async function clickVisible(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{ x: number; y: number } | null>(
      `(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || !element.checkVisibility() || element.disabled) return null;
        element.scrollIntoView({ block: 'center' });
        await new Promise(requestAnimationFrame);
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && element.contains(hit) ? { x, y } : null;
      })()`,
    );
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原界面操作入口尚未显示。");
  await clickOn(page.cdp, page.target.sessionId, point);
}

async function createUnopenedProject(
  context: TaskGroupPublicPageContext,
  label: "B" | "C" | "D",
  kind: "code" | "design" = "code",
) {
  const root = join(
    context.host.workspacePath,
    `等待项目准备返回的目录 ${label}`,
  );
  await mkdir(root);
  const response = await context.host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "saveProject",
    args: [
      {
        creationId: randomUUID(),
        kind,
        name: `等待准备返回的${kind === "code" ? "Code" : "Design"}项目 ${label}`,
        roots: [root],
        primaryRoot: root,
        rootPermissions: {},
        directoryChoice: "independent",
      },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const project = codeProjectEditorProjectSchema.parse(response.body.result);
  expect(project).toMatchObject({
    hostId: "local",
    roots: [{ rootPath: root, position: 0, isPrimary: true }],
  });
  expect(project.id).not.toBe(context.host.projectId);
  return { project, root };
}

async function readTree(context: TaskGroupPublicPageContext) {
  const response = await context.host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function expectOriginalContent(
  { page, host, draft, previewTitle }: TaskGroupPublicPageContext,
  previewText: string,
) {
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          const session = input?.closest('[data-session-id]');
          const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
          return {
            taskId: session?.getAttribute('data-session-id'),
            draft: input?.textContent,
            previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
            previewText: document.querySelector('[data-testid="preview-pane"]')?.textContent,
          };
        })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({
        taskId: host.sessionId,
        draft,
        previewTitle,
        previewText,
      }),
    { timeout: 15_000 },
  ); // 等待原Task通过原侧栏恢复草稿及文件。
}

async function createSessionRequests(
  page: OriginalSessionBrowser,
  projectId: string,
) {
  const commands = [];
  for (const request of requestFacts(page)) {
    if (
      request.service !== "zcodeAgentService" ||
      request.method !== "sendConversationCommandV4"
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
    const [input] = commandRequestSchema.parse(JSON.parse(post.postData)).args;
    if (input.envelope.type !== "createSession") continue;
    const payload = protocol.commandPayloadSchemas.createSession.parse(
      input.envelope.payload,
    );
    if (input.projectId === projectId || payload.workspaceId === projectId)
      commands.push({ requestId: request.requestId, input });
  }
  return commands;
}

async function readDraftView(page: OriginalSessionBrowser) {
  return page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
    return {
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null,
      draft: input?.textContent ?? null,
      projectTitle: document.querySelector(${JSON.stringify(workspaceTrigger)})?.textContent ?? null,
      previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent ?? null,
      previewText: document.querySelector('[data-testid="preview-pane"]')?.textContent ?? null,
    };
  })()`);
}

async function expectProjectPrewarm(
  context: TaskGroupPublicPageContext,
  projectId: string,
  root: string,
) {
  const { page, host } = context;
  const taskId = await vi.waitFor(
    async () => {
      const requests = await createSessionRequests(page, projectId);
      const facts = requestFacts(page);
      const created = requests.find((request) =>
        facts.some(
          (fact) =>
            fact.requestId === request.requestId &&
            fact.state === "finished" &&
            fact.status === 200,
        ),
      );
      if (!created)
        throw new Error(
          `原项目选择尚未取得真实创建回执：${JSON.stringify({ requests, pageErrors: page.pageErrors })}`,
        );
      expect(created.input.workspacePath).toBe(root);
      expect(created.input.workspaceIdentity).toBe(
        canonicalLocalWorkspaceIdentity(projectId, root),
      );
      const payload = protocol.commandPayloadSchemas.createSession.parse(
        created.input.envelope.payload,
      );
      expect(payload.workspaceId).toBe(projectId);
      expect(payload.firstInput).toBeUndefined();
      const response = await readResponseBody(
        page,
        "Network.getResponseBody",
        created.requestId,
      );
      const ack = z
        .object({ result: protocol.commandAckSchema })
        .parse(JSON.parse(response)).result;
      expect(ack).toMatchObject({
        status: "accepted",
        result: { type: "createSession", taskControl: { projectId } },
      });
      if (ack.result?.type !== "createSession")
        throw new Error("原项目选择未返回Task创建结果。");
      return z.uuid().parse(ack.result.sessionId);
    },
    { timeout: 15_000 },
  ); // 等待原草稿预热的真实Task回执，不代发创建或模型输入。
  const response = await host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const scope = codeTaskScopeResponseSchema.parse(response.body).scope;
  expect(scope).toMatchObject({
    instanceId: context.scopeBefore.instanceId,
    projectId,
    taskId,
    rootDirectory: root,
    additionalDirectories: [],
  });
  return { taskId, scope };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目选择迟到响应的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("选择B等待真实准备响应期间返回A，迟到结果保留A历史草稿和文件且不创建B任务", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host, model, scopeBefore, snapshotBefore } = context;
          const { project, root } = await createUnopenedProject(context, "B");
          expect(
            (await readTree(context)).tasks.filter(
              (task) => task.projectId === project.id,
            ),
          ).toEqual([]);
          const previewText = z
            .string()
            .parse(
              await page.evaluate(
                'document.querySelector("[data-testid=preview-pane]")?.textContent',
              ),
            );
          await clickVisible(
            page,
            '[data-testid="sidebar"] [data-testid="task-new-button"]',
          );
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id')`,
              ),
            ).toBe("draft"),
          );
          await clickVisible(page, workspaceTrigger);
          const projectSelector = `[role="menu"] [data-project-id=${JSON.stringify(project.id)}]`;
          await withHeldProjectPreparation(
            page,
            [project.id],
            async (pending) => {
              await clickVisible(page, projectSelector);
              expect(await pending.waitForPrepared(project.id)).toEqual({
                projectId: project.id,
                workspacePath: root,
                workspaceIdentity: canonicalLocalWorkspaceIdentity(
                  project.id,
                  root,
                ),
              });
              await clickVisible(
                page,
                `[data-testid="task-item-${host.sessionId}"]`,
              );
              await expectOriginalContent(context, previewText);
              await page.evaluate(`(() => {
              window.__projectComposerRaceBefore = {
                input: document.querySelector(${JSON.stringify(inputSelector)}),
                preview: document.querySelector('[data-testid="preview-pane"]'),
                tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
              };
            })()`);
              await pending.release(project.id);
              await expectOriginalContent(context, previewText);
              expect(
                await page.evaluate(`(() => {
                const before = window.__projectComposerRaceBefore;
                return {
                  inputPreserved: document.querySelector(${JSON.stringify(inputSelector)}) === before.input,
                  previewPreserved: document.querySelector('[data-testid="preview-pane"]') === before.preview,
                  tabPreserved: document.querySelector('[data-side-pane-tab-id][data-state="active"]') === before.tab,
                };
              })()`),
              ).toEqual({
                inputPreserved: true,
                previewPreserved: true,
                tabPreserved: true,
              });
              expect(await createSessionRequests(page, project.id)).toEqual([]);
              expect(
                (await readTree(context)).tasks.filter(
                  (task) => task.projectId === project.id,
                ),
              ).toEqual([]);
              expect(await readScope(host)).toEqual(scopeBefore);
              const original = protocol.conversationSnapshotSchema.parse(
                await host.snapshot(),
              );
              expect(original.rows.window).toEqual(snapshotBefore.rows.window);
              expect(original.taskControl).toEqual(snapshotBefore.taskControl);
              expect(model.requests).toHaveLength(
                context.modelRequestCountBefore,
              );
            },
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root、独占浏览器、真实响应继续与HTTP/SSE/临时PG关闭期限。

    it("同一A草稿先选B再选C，较早响应保留A草稿且最后选择C持有真实Task目录", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host, model, scopeBefore, snapshotBefore } = context;
          const projectB = await createUnopenedProject(context, "B");
          const projectC = await createUnopenedProject(context, "C");
          const treeBefore = await readTree(context);
          expect(
            treeBefore.tasks.filter(
              (task) =>
                task.projectId === projectB.project.id ||
                task.projectId === projectC.project.id,
            ),
          ).toEqual([]);
          const projectA = treeBefore.projects.find(
            (project) => project.id === host.projectId,
          );
          if (!projectA) throw new Error("原项目A未出现在真实项目目录。");
          const previewText = z
            .string()
            .parse(
              await page.evaluate(
                'document.querySelector("[data-testid=preview-pane]")?.textContent',
              ),
            );
          await clickVisible(
            page,
            '[data-testid="sidebar"] [data-testid="task-new-button"]',
          );
          await vi.waitFor(async () =>
            expect(await readDraftView(page)).toMatchObject({
              taskId: "draft",
            }),
          );
          const draft = "A草稿等待最后一次项目选择";
          await clickVisible(page, inputSelector);
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, draft);
          await vi.waitFor(async () =>
            expect(await readDraftView(page)).toMatchObject({
              taskId: "draft",
              draft,
              projectTitle: projectA.name,
            }),
          );
          const origin = await readDraftView(page);
          await page.evaluate(`(() => {
            window.__projectComposerLatestOriginInput = document.querySelector(${JSON.stringify(inputSelector)});
          })()`);
          await withHeldProjectPreparation(
            page,
            [projectB.project.id, projectC.project.id],
            async (pending) => {
              for (const selected of [projectB, projectC]) {
                await clickVisible(page, workspaceTrigger);
                await clickVisible(
                  page,
                  `[role="menu"] [data-project-id=${JSON.stringify(selected.project.id)}]`,
                );
                expect(
                  await pending.waitForPrepared(selected.project.id),
                ).toEqual({
                  projectId: selected.project.id,
                  workspacePath: selected.root,
                  workspaceIdentity: canonicalLocalWorkspaceIdentity(
                    selected.project.id,
                    selected.root,
                  ),
                });
                expect(await readDraftView(page)).toEqual(origin);
              }
              pending.expectPending(projectB.project.id);
              pending.expectPending(projectC.project.id);
              await pending.release(projectB.project.id);
              pending.expectPending(projectC.project.id);
              expect(await readDraftView(page)).toEqual(origin);
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(inputSelector)}) === window.__projectComposerLatestOriginInput`,
                ),
              ).toBe(true);
              expect(
                await createSessionRequests(page, projectB.project.id),
              ).toEqual([]);
              expect(
                await createSessionRequests(page, projectC.project.id),
              ).toEqual([]);
              expect(
                (await readTree(context)).tasks.filter(
                  (task) => task.projectId === projectB.project.id,
                ),
              ).toEqual([]);
              await pending.release(projectC.project.id);
              await vi.waitFor(async () =>
                expect(await readDraftView(page)).toMatchObject({
                  taskId: "draft",
                  projectTitle: projectC.project.name,
                }),
              );
              const created = await expectProjectPrewarm(
                context,
                projectC.project.id,
                projectC.root,
              );
              expect(created.scope.projectId).not.toBe(projectB.project.id);
              expect(created.taskId).not.toBe(host.sessionId);
              await clickVisible(
                page,
                `[data-testid="task-item-${host.sessionId}"]`,
              );
              await expectOriginalContent(context, previewText);
              expect(
                await createSessionRequests(page, projectB.project.id),
              ).toEqual([]);
              const treeAfter = await readTree(context);
              expect(
                treeAfter.tasks.filter(
                  (task) => task.projectId === projectB.project.id,
                ),
              ).toEqual([]);
              // 空 Task 在首发历史产生后进入目录；新 Task 已由真实 ACK 与公开 Scope 验证。
              expect(
                treeAfter.tasks.filter(
                  (task) => task.projectId === projectC.project.id,
                ),
              ).toEqual([]);
              expect(await readScope(host)).toEqual(scopeBefore);
              const original = protocol.conversationSnapshotSchema.parse(
                await host.snapshot(),
              );
              expect(original.rows.window).toEqual(snapshotBefore.rows.window);
              expect(original.taskControl).toEqual(snapshotBefore.taskControl);
              expect(model.requests).toHaveLength(
                context.modelRequestCountBefore,
              );
            },
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 同一草稿连续选择、独占浏览器及真实HTTP/SSE/临时PG关闭期限。

    it("项目准备期间撤销Code工作方式，真实旧响应保留A草稿与预览并提示重新选择", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host, model, scopeBefore, snapshotBefore } = context;
          const { project, root } = await createUnopenedProject(
            context,
            "D",
            "design",
          );
          const beforeSharing = await host.client.request(
            "/api/projects?kind=design",
          );
          expect(beforeSharing.status, JSON.stringify(beforeSharing.body)).toBe(
            200,
          );
          expect(
            projectListResponseSchema
              .parse(beforeSharing.body)
              .projects.find((entry) => entry.id === project.id),
          ).toMatchObject({ kind: "design", enabledModes: ["design"] });
          const shared = await host.client.request(
            `/api/projects/${project.id}`,
            { enabled_modes: ["design", "code"] },
            "PATCH",
          );
          expect(shared.status, JSON.stringify(shared.body)).toBe(204);
          const codeProjects = await host.client.request(
            "/api/projects?kind=code",
          );
          expect(codeProjects.status, JSON.stringify(codeProjects.body)).toBe(
            200,
          );
          expect(
            projectListResponseSchema
              .parse(codeProjects.body)
              .projects.find((entry) => entry.id === project.id),
          ).toMatchObject({ kind: "design", enabledModes: ["design", "code"] });
          const treeBefore = await readTree(context);
          expect(
            treeBefore.tasks.filter((task) => task.projectId === project.id),
          ).toEqual([]);
          const projectA = treeBefore.projects.find(
            (entry) => entry.id === host.projectId,
          );
          if (!projectA) throw new Error("原项目A未出现在真实项目目录。");
          const previewText = z
            .string()
            .parse(
              await page.evaluate(
                'document.querySelector("[data-testid=preview-pane]")?.textContent',
              ),
            );
          await clickVisible(
            page,
            '[data-testid="sidebar"] [data-testid="task-new-button"]',
          );
          await vi.waitFor(async () =>
            expect(await readDraftView(page)).toMatchObject({
              taskId: "draft",
            }),
          );
          const draft = "A草稿等待工作方式核验";
          await clickVisible(page, inputSelector);
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, draft);
          await vi.waitFor(async () =>
            expect(await readDraftView(page)).toMatchObject({
              taskId: "draft",
              draft,
              projectTitle: projectA.name,
            }),
          );
          const origin = await readDraftView(page);
          await page.evaluate(`(() => {
            window.__projectComposerRevokedModeBefore = {
              input: document.querySelector(${JSON.stringify(inputSelector)}),
              preview: document.querySelector('[data-testid="preview-pane"]'),
              tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
            };
          })()`);
          await withHeldProjectPreparation(
            page,
            [project.id],
            async (pending) => {
              await clickVisible(page, workspaceTrigger);
              await clickVisible(
                page,
                `[role="menu"] [data-project-id=${JSON.stringify(project.id)}]`,
              );
              expect(await pending.waitForPrepared(project.id)).toEqual({
                projectId: project.id,
                workspacePath: root,
                workspaceIdentity: canonicalLocalWorkspaceIdentity(
                  project.id,
                  root,
                ),
              });
              const prepare = requestFacts(page)
                .filter(
                  (request) =>
                    request.service === "project" &&
                    request.method === "prepareSession",
                )
                .at(-1);
              if (!prepare) throw new Error("原项目菜单未发出真实准备请求。");
              const post = z
                .object({ postData: z.string() })
                .parse(
                  await page.cdp.send(
                    "Network.getRequestPostData",
                    { requestId: prepare.requestId },
                    page.target.sessionId,
                  ),
                );
              const [intent] = codeProjectPrepareSessionArgsSchema.parse(
                z.object({ args: z.unknown() }).parse(JSON.parse(post.postData))
                  .args,
              );
              expect(intent).toMatchObject({
                projectId: project.id,
                preset: "code",
              });
              const revoked = await host.client.request(
                `/api/projects/${project.id}`,
                { enabled_modes: ["design"] },
                "PATCH",
              );
              expect(revoked.status, JSON.stringify(revoked.body)).toBe(204);
              const designOnly = await host.client.request(
                "/api/projects?kind=design",
              );
              expect(designOnly.status, JSON.stringify(designOnly.body)).toBe(
                200,
              );
              expect(
                projectListResponseSchema
                  .parse(designOnly.body)
                  .projects.find((entry) => entry.id === project.id),
              ).toMatchObject({ kind: "design", enabledModes: ["design"] });
              pending.expectPending(project.id);
              expect(await readDraftView(page)).toEqual(origin);
              await pending.release(project.id);
              expect(await readDraftView(page)).toEqual(origin);
              await vi.waitFor(async () =>
                expect(
                  await page.evaluate(`(() => {
                    const toast = document.querySelector('#zcode-toast-host');
                    return toast?.checkVisibility() ? toast.textContent : null;
                  })()`),
                  JSON.stringify(page.pageErrors),
                ).toContain("项目工作方式已改变，请重新选择项目。"),
              );
              expect(
                await page.evaluate(`(() => {
                  const before = window.__projectComposerRevokedModeBefore;
                  return {
                    inputPreserved: document.querySelector(${JSON.stringify(inputSelector)}) === before.input,
                    previewPreserved: document.querySelector('[data-testid="preview-pane"]') === before.preview,
                    tabPreserved: document.querySelector('[data-side-pane-tab-id][data-state="active"]') === before.tab,
                  };
                })()`),
              ).toEqual({
                inputPreserved: true,
                previewPreserved: true,
                tabPreserved: true,
              });
              expect(await createSessionRequests(page, project.id)).toEqual([]);
              expect(
                (await readTree(context)).tasks.filter(
                  (task) => task.projectId === project.id,
                ),
              ).toEqual([]);
              await clickVisible(
                page,
                `[data-testid="task-item-${host.sessionId}"]`,
              );
              await expectOriginalContent(context, previewText);
              expect(await readScope(host)).toEqual(scopeBefore);
              const original = protocol.conversationSnapshotSchema.parse(
                await host.snapshot(),
              );
              expect(original.rows.window).toEqual(snapshotBefore.rows.window);
              expect(original.taskControl).toEqual(snapshotBefore.taskControl);
              expect(model.requests).toHaveLength(
                context.modelRequestCountBefore,
              );
            },
          );
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 可信连接撤销工作方式、原响应继续及真实HTTP/SSE/临时PG关闭期限。
  },
);
