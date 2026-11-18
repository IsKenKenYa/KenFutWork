// @vitest-environment node
import { fileURLToPath } from "node:url";
import {
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import type { PublicFixture } from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type HttpFixture = PublicFixture & { origin: string };
interface ApprovalRootContext {
  fixture: HttpFixture;
  host: Host;
  model: Model;
  page: OriginalSessionBrowser;
}
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const taskTitle = "原侧栏显示真实审批等待";
const outputMarker = "SIDEBAR_APPROVAL_ACTIVITY_DONE";
const allowSelector = '[data-permission-option-kind="allowOnce"]';

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function readTask(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("真实项目树缺少审批Task。");
  return task;
}

async function withApprovalRoot(
  work: (context: ApprovalRootContext) => Promise<void>,
) {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<HttpFixture>;
  }> = import(fixturePath);
  const [http, sessions, streams] = await Promise.all([
    httpLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
  ]);
  const fixture = await http.createCodeUiHttpFixture();
  let host: Host | undefined;
  let model: Model | undefined;
  let page: OriginalSessionBrowser | undefined;
  const failures: unknown[] = [];
  try {
    model = await streams.heldModel({
      initialTool: {
        id: "original-sidebar-approval",
        name: "Bash",
        arguments: { command: `printf '${outputMarker}'` },
      },
    });
    host = await sessions.createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig: { mode: "build", planEnabled: false },
    });
    page = await openOriginalSessionBrowser({
      backendBaseUrl: fixture.baseUrl,
      backendOrigin: fixture.origin,
      accessToken: await fixture.app.kernel
        .get("localAccess")
        .getDesktopToken(),
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      sessionId: host.sessionId,
      clientId: host.clientId,
      workspaceShell: true,
      beforeNavigate: async ({ cdp, target }) => {
        const preference = JSON.stringify({
          view: "projects",
          order: [],
          expanded: {},
        });
        await cdp.send(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(preference)});`,
          },
          target.sessionId,
        );
      },
    });
    await work({ fixture, host, model, page });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      () => page?.close(),
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
    throw new AggregateError(failures, "原侧栏审批提示验证或资源关闭失败", {
      cause: failures[0],
    });
}

async function beginApproval({ host, model }: ApprovalRootContext) {
  const sent = await host.command("sendText", { text: taskTitle });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  return vi.waitFor(
    async () => {
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const interaction = current.pendingInteractions.find(
        (entry) => entry.payload.kind === "permission",
      );
      expect(current.control.phase).toBe("running");
      expect(interaction?.payload.kind).toBe("permission");
      expect(model.requests).toHaveLength(1);
      return current;
    },
    { timeout: 30_000 },
  ); // 等待真实模型工具调用进入原审批门。
}

async function expectSidebarAttention(
  { page, host }: ApprovalRootContext,
  waiting: boolean,
) {
  const selector = `section[data-project-id="${host.projectId}"] [data-testid="task-item-${host.sessionId}"]`;
  await vi.waitFor(
    async () => {
      const state = await page.evaluate<{
        projectId: string | null;
        text: string;
      } | null>(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      return row && row.checkVisibility() ? {
        projectId: row.closest('section[data-project-id]')?.getAttribute('data-project-id') ?? null,
        text: row.textContent,
      } : null;
    })()`);
      expect(state, JSON.stringify(page.pageErrors)).toMatchObject({
        projectId: host.projectId,
        text: expect.stringContaining(taskTitle),
      });
      expect(
        state?.text.includes("等待确认"),
        JSON.stringify(page.pageErrors),
      ).toBe(waiting);
    },
    { timeout: 30_000 },
  ); // 原侧栏消费真实SSE活动，不直接更新组件或store。
}

async function approveFromOriginalCard({
  page,
  host,
  model,
}: ApprovalRootContext) {
  await clickOn(page.cdp, page.target.sessionId, { selector: allowSelector });
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  model.finish(1);
  return vi.waitFor(
    async () => {
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(current.control.phase).toBe("completedSuccess");
      expect(current.pendingInteractions).toEqual([]);
      expect(
        current.rows.window.filter(
          (row) => row.kind === "toolCall" && row.toolName === "Bash",
        ),
      ).toContainEqual(
        expect.objectContaining({
          status: "success",
          output: expect.objectContaining({
            text: expect.stringContaining(outputMarker),
          }),
        }),
      );
      return current;
    },
    { timeout: 30_000 },
  ); // 原审批按钮恢复真实工具执行和后续模型HTTP。
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原ProjectSidebar活动提示的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("真实Bash审批等待显示侧栏等待确认，原允许按钮接纳后消失且Task身份与权限保持", async () => {
      await withApprovalRoot(async (context) => {
        const { host, page, model } = context;
        const scopeBefore = await readScope(host);
        const waiting = await beginApproval(context);
        await vi.waitFor(
          async () =>
            expect(
              await page.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(allowSelector)});
          return Boolean(button?.checkVisibility());
        })()`),
              JSON.stringify(page.pageErrors),
            ).toBe(true),
          { timeout: 30_000 },
        );
        const taskBefore = await readTask(host);
        expect(taskBefore).toMatchObject({
          projectId: host.projectId,
          workspacePath: host.workspacePath,
          workspaceIdentity: JSON.stringify([
            host.projectId,
            host.workspacePath,
          ]),
          taskId: host.sessionId,
          taskControl: waiting.taskControl,
        });
        await expectSidebarAttention(context, true);
        const completed = await approveFromOriginalCard(context);
        await expectSidebarAttention(context, false);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(completed.taskControl).toEqual(waiting.taskControl);
        expect(await readTask(host)).toMatchObject({
          projectId: taskBefore.projectId,
          workspacePath: taskBefore.workspacePath,
          workspaceIdentity: taskBefore.workspaceIdentity,
          taskId: taskBefore.taskId,
          taskControl: taskBefore.taskControl,
        });
        expect(model.requests).toHaveLength(2);
      });
    }, 180_000); // 原Root生产构建、独占浏览器、真实审批与全部资源关闭期限。
  },
);
