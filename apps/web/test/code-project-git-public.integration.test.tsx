// @vitest-environment node
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeUiViewerScopeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import { createProjectGitFixture } from "../../server/src/features/code-ui/project-git.fixture.js";
import { observeViewerRequests } from "./setup/code-file-viewer-public.fixture.js";
import { selectSidebarView } from "./setup/code-public-browser-actions.js";
import {
  readScope,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const targetSchema = z.object({ viewerScope: codeUiViewerScopeSchema });
const inputSelector = '[role="textbox"][contenteditable="true"]';

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原FileManager的Project Git、真实宿主与PostgreSQL integration",
  () => {
    it("A会话查看无Task项目B的真实Git，原输入、草稿及A权限保持", async () => {
      await withTaskGroupPublicPage(
        async (context) => {
          const { fixture, host, page, model, draft } = context;
          const { root } = await createProjectGitFixture(fixture.directory);
          const saved = await host.client.request("/api/code-ui/rpc", {
            service: "project",
            method: "saveProject",
            args: [
              {
                creationId: randomUUID(),
                kind: "code",
                name: "原Project Git验证",
                roots: [root],
                primaryRoot: root,
                rootPermissions: {},
              },
            ],
          });
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const project = codeProjectEditorProjectSchema.parse(
            saved.body.result,
          );
          const readTasks = async () => {
            const response = await host.client.request("/api/code-ui/rpc", {
              service: "project",
              method: "readTree",
              args: [{}],
            });
            expect(response.status).toBe(200);
            return codeProjectTreeSchema
              .parse(response.body.result)
              .tasks.filter((task) => task.projectId === project.id);
          };
          expect(await readTasks()).toEqual([]);
          const denied = await host.client.request("/api/code-ui/rpc", {
            service: "file",
            method: "readTextFile",
            args: [
              {
                path: join(root, "tracked.txt"),
                viewerScope: { kind: "task", taskId: host.sessionId },
              },
            ],
          });
          expect(denied.status).toBe(404);
          const observation = observeViewerRequests(page);
          try {
            await selectSidebarView(page, "projects");
            const button = `[data-project-id=${JSON.stringify(project.id)}] [data-testid="virtual-project-files"]`;
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `Boolean(document.querySelector(${JSON.stringify(button)}))`,
                ),
              ).toBe(true),
            );
            await clickOn(page.cdp, page.target.sessionId, {
              selector: button,
            });
            await vi.waitFor(
              async () =>
                expect(
                  await page.evaluate(`(() => {
            const pane = Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility());
            const row = pane?.querySelector('[data-testid=${JSON.stringify(`workspace-file-tree-row-${join(root, "tracked.txt")}`)}]');
            return row?.querySelector('[aria-label="修改"]')?.textContent;
          })()`),
                  JSON.stringify(page.pageErrors),
                ).toBe("M"),
              { timeout: 10_000 },
            );
            await vi.waitFor(
              () => {
                for (const method of ["refresh", "getIgnoredPaths"]) {
                  const requests = [...observation.requests.values()].filter(
                    (request) => {
                      const parsed = targetSchema.safeParse(request.args[0]);
                      return (
                        request.service === "git" &&
                        request.method === method &&
                        parsed.success &&
                        parsed.data.viewerScope.kind === "project" &&
                        parsed.data.viewerScope.projectId === project.id
                      );
                    },
                  );
                  expect(
                    requests,
                    JSON.stringify([...observation.requests.values()]),
                  ).not.toHaveLength(0);
                  expect(requests.map((request) => request.status)).toEqual(
                    requests.map(() => 200),
                  );
                }
              },
              { timeout: 10_000 },
            );
            expect(
              await page.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(inputSelector)});
            return { same: input === window.__taskGroupPublicBefore.input, draft: input?.textContent,
              taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') };
          })()`),
            ).toEqual({ same: true, draft, taskId: host.sessionId });
            expect(await readScope(host)).toEqual(context.scopeBefore);
            expect(
              protocol.conversationSnapshotSchema.parse(await host.snapshot())
                .rows.window,
            ).toEqual(context.snapshotBefore.rows.window);
            expect(await readTasks()).toEqual([]);
            expect(model.requests).toHaveLength(
              context.modelRequestCountBefore,
            );
          } finally {
            observation.dispose();
          }
        },
        { seedTaskHistory: true },
      );
    }, 180_000); // 原Root、空项目文件入口、真实Git/沙箱/PG/HTTP/SSE与独占Chrome。
  },
);
