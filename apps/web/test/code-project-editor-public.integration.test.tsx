// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeProjectEditorProjectSchema,
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
import {
  clickExactText,
  selectAll,
} from "./setup/code-public-browser-actions.js";
import type { PublicFixture } from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
const inputSelector = '[role="textbox"][contenteditable="true"]';
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function hoverOn(page: OriginalSessionBrowser, selector: string) {
  const target = await page.evaluate<{
    x: number;
    y: number;
  } | null>(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: "center" });
    const panel = element.closest('[aria-hidden]');
    if (panel) await Promise.all(panel.getAnimations().map(animation => animation.finished));
    await new Promise(requestAnimationFrame);
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || !element.contains(hit)) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!target) throw new Error("原项目行尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...target },
    page.target.sessionId,
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目编辑器的原Root公共 integration",
  () => {
    it("原项目菜单改名后保留同一Task、正文草稿与内容目标，名称持久且旧授权不变", async () => {
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
        const session = host;
        const readProjects = async () => {
          const result = await session.client.request("/api/code-ui/rpc", {
            service: "project",
            method: "readProjects",
            args: [{ hostId: "local" }],
          });
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          return codeProjectEditorProjectSchema
            .array()
            .parse(result.body.result);
        };
        const readScope = async () => {
          const result = await session.client.request(
            `/api/code-ui/tasks/${session.sessionId}/scope`,
          );
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          return codeTaskScopeResponseSchema.parse(result.body).scope;
        };
        const initialProject = (await readProjects()).find(
          (project) => project.id === session.projectId,
        );
        if (!initialProject) throw new Error("真实项目列表缺少目标项目。");
        const initialScope = await readScope();
        const initialSession = protocol.conversationSnapshotSchema.parse(
          await session.snapshot(),
        );
        const previewName = "项目改名保留内容.txt";
        const previewPath = join(session.workspacePath, previewName);
        await writeFile(previewPath, "项目改名保留当前内容目标\n", "utf8");
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: session.workspacePath,
          projectId: session.projectId,
          sessionId: session.sessionId,
          clientId: session.clientId,
          workspaceShell: true,
        });
        const page = browser;
        const projectSelector = `[data-project-id=${JSON.stringify(session.projectId)}]`;
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const input = document.querySelector(${JSON.stringify(inputSelector)});
              return input?.closest('[data-session-id]')?.getAttribute('data-session-id');
            })()`),
            JSON.stringify(page.pageErrors),
          ).toBe(session.sessionId),
        );
        await clickExactText(
          page,
          '[data-testid="sidebar"] [role="tab"]',
          "项目",
        );
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelectorAll(${JSON.stringify(projectSelector)}).length`,
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(1),
        );
        const treeButton = `${projectSelector} [data-testid=${JSON.stringify(`workspace-file-tree-button-${session.workspacePath}`)}]`;
        await hoverOn(page, projectSelector);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelectorAll(${JSON.stringify(treeButton)}).length`,
            ),
          ).toBe(1),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: treeButton,
        });
        const fileSelector = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${previewPath}`)}]`;
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelectorAll(${JSON.stringify(fileSelector)}).length`,
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(1),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: fileSelector,
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const tabs = Array.from(document.querySelectorAll('[data-side-pane-tab-id][data-state="active"]'));
              return {
                titles: tabs.map(tab => tab.querySelector('[data-side-pane-tab-title]')?.textContent),
                previewReady: Boolean(document.querySelector('[data-testid="preview-pane"]')),
              };
            })()`),
            JSON.stringify(page.pageErrors),
          ).toEqual({ titles: [previewName], previewReady: true }),
        );
        await clickExactText(
          page,
          '[data-testid="workspace-file-tree-panel"] button',
          "返回任务",
        );
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=workspace-file-tree-panel]")?.closest("[aria-hidden]")?.getAttribute("aria-hidden")',
            ),
          ).toBe("true"),
        );
        const draft = "项目改名期间保留的正文草稿";
        await clickOn(page.cdp, page.target.sessionId, {
          selector: inputSelector,
        });
        expect(
          await page.evaluate(
            `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
          ),
        ).toBe("");
        await typeText(page.cdp, page.target.sessionId, draft);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
            ),
          ).toBe(draft),
        );
        await page.evaluate(`(() => {
          window.__projectEditorPublicState = {
            input: document.querySelector(${JSON.stringify(inputSelector)}),
            preview: document.querySelector('[data-testid="preview-pane"]'),
            tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
          };
        })()`);
        await hoverOn(page, projectSelector);
        const moreSelector = `${projectSelector} button[aria-label="更多"]`;
        await vi.waitFor(async () => {
          const state = await page.evaluate<{ count: number }>(`(() => {
            const row = document.querySelector(${JSON.stringify(projectSelector)});
            const rect = row?.getBoundingClientRect();
            const fileTree = document.querySelector('[data-testid="workspace-file-tree-panel"]')?.closest('[aria-hidden]');
            const style = fileTree ? getComputedStyle(fileTree) : null;
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
            return {
              count: document.querySelectorAll(${JSON.stringify(moreSelector)}).length,
              hovered: row?.matches(':hover'),
              buttons: Array.from(row?.querySelectorAll('button') ?? [], button => ({ label: button.getAttribute('aria-label'), text: button.textContent })),
              pointerTarget: rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML.slice(0, 700) : null,
              hitInRow: Boolean(row && hit && row.contains(hit)),
              hitHidden: hit?.closest('[aria-hidden]')?.getAttribute('aria-hidden'),
              fileTree: fileTree ? { className: fileTree.className, hidden: fileTree.getAttribute('aria-hidden'), translate: style?.translate, transform: style?.transform, pointerEvents: style?.pointerEvents, rect: fileTree.getBoundingClientRect().toJSON() } : null,
              rect: rect?.toJSON(),
              text: document.body.innerText.slice(-1000),
            };
          })()`);
          expect(state.count, JSON.stringify(state)).toBe(1);
        });
        await clickOn(page.cdp, page.target.sessionId, {
          selector: moreSelector,
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'document.querySelectorAll("[data-testid=code-project-edit]").length',
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(1),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[data-testid="code-project-edit"]',
        });
        const nameSelector = '[data-testid="virtual-project-name"]';
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(initialProject.name),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: nameSelector,
        });
        await selectAll(page);
        const nextName = "原项目编辑器名称已保存";
        await typeText(page.cdp, page.target.sessionId, nextName);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
            ),
          ).toBe(nextName),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[data-testid="virtual-project-save"]',
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'document.querySelector("[data-testid=virtual-project-name]") === null',
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(true),
        );
        const expectProjectUI = (name: string) =>
          vi.waitFor(async () => {
            const state = await page.evaluate<{
              sameInput: boolean;
              samePreview: boolean;
              sameContentTab: boolean;
              draft?: string | null;
              taskId?: string | null;
              contentTitle?: string | null;
              projectLabel?: string | null;
              projectContext?: string | null;
            }>(`(() => {
            const original = window.__projectEditorPublicState;
            const input = document.querySelector(${JSON.stringify(inputSelector)});
            const preview = document.querySelector('[data-testid="preview-pane"]');
            const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
            const row = document.querySelector(${JSON.stringify(projectSelector)});
            return {
              sameInput: Boolean(original?.input && input === original.input),
              samePreview: Boolean(original?.preview && preview === original.preview),
              sameContentTab: Boolean(original?.tab && tab === original.tab),
              draft: input?.textContent,
              taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
              contentTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
              projectLabel: row?.textContent,
              projectContext: document.querySelector('[data-testid="workspace-path"]')?.getAttribute('aria-label'),
            };
            })()`);
            expect(state, JSON.stringify(page.pageErrors)).toMatchObject({
              sameInput: true,
              samePreview: true,
              sameContentTab: true,
              draft,
              taskId: session.sessionId,
              contentTitle: previewName,
              projectContext: name,
            });
            expect(state.projectLabel).toContain(name);
          });
        await expectProjectUI(nextName);
        const savedProject = (await readProjects()).find(
          (project) => project.id === session.projectId,
        );
        if (!savedProject) throw new Error("改名后真实项目列表缺少原项目。");
        expect(savedProject).toMatchObject({
          id: initialProject.id,
          name: nextName,
          roots: initialProject.roots,
          createdAt: initialProject.createdAt,
          revision: initialProject.revision + 1,
        });
        expect(savedProject.updatedAt).toBeGreaterThanOrEqual(
          initialProject.updatedAt,
        );
        expect(await readScope()).toEqual(initialScope);
        const after = protocol.conversationSnapshotSchema.parse(
          await session.snapshot(),
        );
        expect(after.sessionId).toBe(session.sessionId);
        expect(after.rows.window).toEqual(initialSession.rows.window);
        const externalName = "另一连接保存的项目名称";
        const externallySaved = await session.client.request(
          "/api/code-ui/rpc",
          {
            service: "project",
            method: "saveProject",
            args: [
              {
                id: savedProject.id,
                name: externalName,
                roots: savedProject.roots.map((root) => root.rootPath),
                primaryRoot: session.workspacePath,
                rootPermissions: Object.fromEntries(
                  savedProject.roots.flatMap((root) =>
                    root.access ? [[root.rootPath, root.access]] : [],
                  ),
                ),
                expectedRevision: savedProject.revision,
              },
            ],
          },
        );
        expect(
          externallySaved.status,
          JSON.stringify(externallySaved.body),
        ).toBe(200);
        expect(externallySaved.body.result).toMatchObject({
          name: externalName,
          revision: savedProject.revision + 1,
        });
        await expectProjectUI(externalName);
        expect(await readScope()).toEqual(initialScope);
        expect(
          (await readProjects()).find(
            (project) => project.id === session.projectId,
          )?.name,
        ).toBe(externalName);
        expect(model.requests).toEqual([]);
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
        throw new AggregateError(failures, "原项目编辑器验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
