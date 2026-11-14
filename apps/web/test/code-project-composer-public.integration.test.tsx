// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalLocalWorkspaceIdentity } from "../../../packages/zcode-shared/dist/index.js";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const workspaceTrigger = '[data-testid="composer-workspace-trigger"]';
const requestFactSchema = z.object({
  requestId: z.string(),
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

function requestFacts(page: OriginalSessionBrowser) {
  return z.array(requestFactSchema).parse(page.requests);
}

async function readTree({ host }: TaskGroupPublicPageContext) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function createProject(
  { host }: TaskGroupPublicPageContext,
  root: string,
  name: string,
  kind: "code" | "design",
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "saveProject",
    args: [
      {
        creationId: randomUUID(),
        kind,
        name,
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
    name,
    roots: [{ rootPath: root, position: 0, isPrimary: true }],
  });
  return project;
}

async function prepareUnopenedProjects(context: TaskGroupPublicPageContext) {
  const root = join(context.host.workspacePath, "尚未打开的项目目录");
  const designRoot = join(context.host.workspacePath, "独立Design项目目录");
  await mkdir(root);
  await mkdir(designRoot);
  const projectB = await createProject(
    context,
    root,
    "未打开的Code项目 B",
    "code",
  );
  const projectC = await createProject(
    context,
    root,
    "同目录独立Code项目 C",
    "code",
  );
  const projectD = await createProject(
    context,
    designRoot,
    "未共享的Design项目 D",
    "design",
  );
  const projects = [projectB, projectC, projectD];
  const ids = new Set(projects.map((project) => project.id));
  expect(ids.size).toBe(3);
  expect(ids.has(context.host.projectId)).toBe(false);
  const tree = await readTree(context);
  expect(tree.projects.filter((project) => ids.has(project.id))).toHaveLength(
    3,
  );
  expect(tree.tasks.filter((task) => ids.has(task.projectId))).toEqual([]);
  return { projectB, projectC, projectD, root };
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

async function openProjectMenu(page: OriginalSessionBrowser) {
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
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'Array.from(document.querySelectorAll("[role=menu]")).some(menu => menu.checkVisibility())',
      ),
    ).toBe(true),
  );
}

async function expectProjectChoices(
  page: OriginalSessionBrowser,
  projects: Awaited<ReturnType<typeof prepareUnopenedProjects>>,
) {
  await vi.waitFor(async () => {
    const rows = await page.evaluate<Array<{ id: string; text: string }>>(`
      Array.from(document.querySelectorAll('[role="menu"] [data-project-id]'))
        .filter(element => element.checkVisibility())
        .map(element => ({ id: element.getAttribute('data-project-id'), text: element.textContent }))
    `);
    expect(rows, JSON.stringify(page.pageErrors)).toEqual(
      expect.arrayContaining([
        {
          id: projects.projectB.id,
          text: expect.stringContaining(projects.projectB.name),
        },
        {
          id: projects.projectC.id,
          text: expect.stringContaining(projects.projectC.name),
        },
      ]),
    );
    expect(rows.filter((row) => row.id === projects.projectB.id)).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.id === projects.projectC.id)).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.id === projects.projectD.id)).toEqual([]);
  });
}

async function readCommand(page: OriginalSessionBrowser, requestId: string) {
  const post = z
    .object({ postData: z.string() })
    .parse(
      await page.cdp.send(
        "Network.getRequestPostData",
        { requestId },
        page.target.sessionId,
      ),
    );
  const [input] = commandRequestSchema.parse(JSON.parse(post.postData)).args;
  const response = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      ),
    );
  const body = JSON.parse(
    response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body,
  );
  const ack = z
    .object({ result: protocol.commandAckSchema })
    .parse(body).result;
  return { input, ack };
}

async function expectProjectPrewarm(
  context: TaskGroupPublicPageContext,
  project: CodeProjectEditorProject,
  root: string,
  previous: ReadonlySet<string>,
) {
  const { page, host } = context;
  const commands = new Map<string, Awaited<ReturnType<typeof readCommand>>>();
  return vi.waitFor(
    async () => {
      const requests = requestFacts(page).filter(
        (request) =>
          !previous.has(request.requestId) &&
          request.service === "zcodeAgentService" &&
          request.method === "sendConversationCommandV4" &&
          request.state === "finished" &&
          request.status === 200,
      );
      for (const request of requests)
        if (!commands.has(request.requestId))
          commands.set(
            request.requestId,
            await readCommand(page, request.requestId),
          );
      const created = [...commands.values()]
        .filter(
          ({ input, ack }) =>
            input.projectId === project.id &&
            input.envelope.type === "createSession" &&
            ack.status === "accepted" &&
            ack.result?.type === "createSession",
        )
        .at(-1);
      if (!created)
        throw new Error(
          `原项目选择尚未取得真实Task创建回执：${JSON.stringify({ requests, pageErrors: page.pageErrors })}`,
        );
      expect(created.input.workspacePath).toBe(root);
      expect(created.input.workspaceIdentity).toBe(
        canonicalLocalWorkspaceIdentity(project.id, root),
      );
      expect(
        protocol.commandPayloadSchemas.createSession.parse(
          created.input.envelope.payload,
        ).workspaceId,
      ).toBe(project.id);
      expect(created.ack.result).toMatchObject({
        type: "createSession",
        taskControl: { projectId: project.id },
      });
      const taskId = z
        .uuid()
        .parse(
          created.ack.result?.type === "createSession"
            ? created.ack.result.sessionId
            : null,
        );
      const response = await host.client.request(
        `/api/code-ui/tasks/${taskId}/scope`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const scope = codeTaskScopeResponseSchema.parse(response.body).scope;
      expect(scope).toMatchObject({
        instanceId: context.scopeBefore.instanceId,
        projectId: project.id,
        taskId,
        rootDirectory: root,
        additionalDirectories: [],
      });
      return { taskId, scope };
    },
    { timeout: 15_000 },
  ); // 仅等待原草稿预热产生真实Task与公开权限，不代发创建或模型输入。
}

async function expectOriginalTaskRestored(
  context: TaskGroupPublicPageContext,
  previewText: string,
) {
  const { page, host, draft, previewTitle } = context;
  await clickVisible(page, `[data-testid="task-item-${host.sessionId}"]`);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
        return {
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          draft: input?.textContent,
          previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
          previewText: document.querySelector('[data-testid="preview-pane"]')?.textContent,
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ taskId: host.sessionId, draft, previewTitle, previewText }),
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目选择菜单的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("未打开的同目录Code项目分别可选，选择B按其ID创建Task且原A草稿和权限保持", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { page, host, model, scopeBefore, snapshotBefore } = context;
          const projects = await prepareUnopenedProjects(context);
          const previewText = z
            .string()
            .parse(
              await page.evaluate(
                'document.querySelector("[data-testid=preview-pane]")?.textContent',
              ),
            );
          await openProjectMenu(page);
          await expectProjectChoices(page, projects);
          const previous = new Set(
            requestFacts(page).map((request) => request.requestId),
          );
          await clickVisible(
            page,
            `[role="menu"] [data-project-id=${JSON.stringify(projects.projectB.id)}]`,
          );
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(workspaceTrigger)})?.textContent`,
              ),
            ).toContain(projects.projectB.name),
          );
          const created = await expectProjectPrewarm(
            context,
            projects.projectB,
            projects.root,
            previous,
          );
          expect(created.scope.projectId).not.toBe(projects.projectC.id);
          expect(created.taskId).not.toBe(host.sessionId);
          await expectOriginalTaskRestored(context, previewText);
          expect(await readScope(host)).toEqual(scopeBefore);
          const snapshot = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          expect(snapshot.rows.window).toEqual(snapshotBefore.rows.window);
          expect(snapshot.taskControl).toEqual(snapshotBefore.taskControl);
          const tree = await readTree(context);
          expect(
            tree.tasks.filter(
              (task) =>
                task.projectId === projects.projectC.id ||
                task.projectId === projects.projectD.id,
            ),
          ).toEqual([]);
          expect(model.requests).toHaveLength(context.modelRequestCountBefore);
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root、独占浏览器、真实项目选择与HTTP/SSE/临时PG关闭期限。
  },
);
