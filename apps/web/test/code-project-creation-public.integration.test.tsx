// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
  codeTaskScopeResponseSchema,
  projectListResponseSchema,
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
type HttpFixture = PublicFixture & { origin: string };
type CreationPageOptions = {
  previewName: string;
  previewText: string;
  draft: string;
};
const inputSelector = '[role="textbox"][contenteditable="true"]';
const nameSelector = '[data-testid="virtual-project-name"]';
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

type CreationPageCheck = {
  page: OriginalSessionBrowser;
  session: Host;
  model: Model;
  previewName: string;
  draft: string;
  projectsBefore: CodeProjectEditorProject[];
  scopeBefore: ReturnType<typeof codeTaskScopeResponseSchema.parse>["scope"];
  sessionBefore: protocol.ConversationSnapshot;
  readProjects(): Promise<CodeProjectEditorProject[]>;
  readScope(): Promise<
    ReturnType<typeof codeTaskScopeResponseSchema.parse>["scope"]
  >;
  recordCreatedProject(id: string): void;
};

async function waitForDialogTarget(
  page: OriginalSessionBrowser,
  selector: string,
) {
  await page.evaluate(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const dialog = target?.closest('[role="dialog"]');
    if (!target || !dialog) throw new Error("原项目对话框操作入口未显示。");
    const sibling = dialog.previousElementSibling;
    const overlay = sibling?.matches('[data-slot="dialog-overlay"]') ? sibling : null;
    await Promise.all([
      ...dialog.getAnimations({ subtree: true }),
      ...(overlay?.getAnimations({ subtree: true }) ?? []),
    ].map(animation => animation.finished));
    target.scrollIntoView({ block: "center" });
    await new Promise(requestAnimationFrame);
  })()`);
  await vi.waitFor(async () => {
    const state = await page.evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const rect = target?.getBoundingClientRect();
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      return {
        visible: target?.checkVisibility() ?? false,
        disabled: target?.disabled ?? null,
        hit: Boolean(target && hit && target.contains(hit)),
        hitTestId: hit?.getAttribute('data-testid') ?? null,
      };
    })()`);
    expect(
      state,
      JSON.stringify({ selector, state, pageErrors: page.pageErrors }),
    ).toMatchObject({ visible: true, disabled: false, hit: true });
  });
}

function readCreationSurface(page: OriginalSessionBrowser) {
  return page.evaluate<Record<string, unknown>>(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const name = document.querySelector(${JSON.stringify(nameSelector)});
    const form = name?.closest('[role="dialog"]');
    const save = document.querySelector('[data-testid="virtual-project-save"]');
    const trust = document.querySelector('[data-testid="project-folder-trust-dialog"]');
    const confirm = document.querySelector('[data-testid="project-folder-trust-confirm"]');
    const rect = confirm?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    const contentTab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
    return {
      formClosed: name === null,
      form: name ? {
        name: name.value,
        nameDisabled: name.disabled,
        visible: name.checkVisibility(),
        alerts: Array.from(form?.querySelectorAll('[role="alert"]') ?? [], alert => alert.textContent),
        saveDisabled: save?.disabled,
        saveText: save?.textContent,
      } : null,
      trust: {
        present: Boolean(trust),
        confirmVisible: confirm?.checkVisibility() ?? false,
        confirmDisabled: confirm?.disabled ?? null,
        hitTestId: hit?.getAttribute('data-testid') ?? null,
        hitButtonTestId: hit?.closest('button')?.getAttribute('data-testid') ?? null,
        confirmContainsHit: Boolean(confirm && hit && confirm.contains(hit)),
        focusedTestId: document.activeElement?.getAttribute('data-testid') ?? null,
      },
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      draft: input?.textContent,
      contentTabId: contentTab?.getAttribute('data-side-pane-tab-id'),
      contentTitle: contentTab?.querySelector('[data-side-pane-tab-title]')?.textContent,
      workspaceLabel: document.querySelector('[data-testid="workspace-path"]')?.getAttribute('aria-label'),
    };
  })()`);
}

async function expectTaskPreserved({
  page,
  session,
  model,
  previewName,
  draft,
  scopeBefore,
  sessionBefore,
  readScope,
}: CreationPageCheck) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const original = window.__projectCreationPublicState;
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        const preview = document.querySelector('[data-testid="preview-pane"]');
        const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
        return {
          formClosed: document.querySelector(${JSON.stringify(nameSelector)}) === null,
          sameInput: Boolean(original.input && input === original.input),
          samePreview: Boolean(original.preview && preview === original.preview),
          sameContentTab: Boolean(original.tab && tab === original.tab),
          draft: input?.textContent,
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
          contentTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      formClosed: true,
      sameInput: true,
      samePreview: true,
      sameContentTab: true,
      draft,
      taskId: session.sessionId,
      contentTitle: previewName,
    }),
  );
  expect(await readScope()).toEqual(scopeBefore);
  const after = protocol.conversationSnapshotSchema.parse(
    await session.snapshot(),
  );
  expect(after.sessionId).toBe(session.sessionId);
  expect(after.rows.window).toEqual(sessionBefore.rows.window);
  expect(model.requests).toEqual([]);
}

async function readProjectDirectory(session: Host) {
  const result = await session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readProjects",
    args: [{ hostId: "local" }],
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeProjectEditorProjectSchema.array().parse(result.body.result);
}

async function readTaskScope(session: Host) {
  const result = await session.client.request(
    `/api/code-ui/tasks/${session.sessionId}/scope`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(result.body).scope;
}

async function openProjectFileTree(
  page: OriginalSessionBrowser,
  session: Host,
) {
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
  await clickExactText(page, '[data-testid="sidebar"] [role="tab"]', "项目");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelectorAll(${JSON.stringify(projectSelector)}).length`,
      ),
    ).toBe(1),
  );
  const projectPoint = await page.evaluate<{
    x: number;
    y: number;
  } | null>(`(async () => {
    const row = document.querySelector(${JSON.stringify(projectSelector)});
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    await new Promise(requestAnimationFrame);
    const rect = row.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit && row.contains(hit) ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  if (!projectPoint) throw new Error("原项目行未进入可点击区域。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...projectPoint },
    page.target.sessionId,
  );
  const treeSelector = `${projectSelector} [data-testid=${JSON.stringify(`workspace-file-tree-button-${session.workspacePath}`)}]`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelectorAll(${JSON.stringify(treeSelector)}).length`,
      ),
    ).toBe(1),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: treeSelector });
  return projectSelector;
}

async function openTaskPreview(
  page: OriginalSessionBrowser,
  session: Host,
  previewName: string,
) {
  const projectSelector = await openProjectFileTree(page, session);
  const previewPath = join(session.workspacePath, previewName);
  const fileSelector = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${previewPath}`)}]`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelectorAll(${JSON.stringify(fileSelector)}).length`,
      ),
    ).toBe(1),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: fileSelector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const tabs = Array.from(document.querySelectorAll('[data-side-pane-tab-id][data-state="active"]'));
        return {
          titles: tabs.map(tab => tab.querySelector('[data-side-pane-tab-title]')?.textContent),
          preview: Boolean(document.querySelector('[data-testid="preview-pane"]')),
        };
      })()`),
    ).toEqual({ titles: [previewName], preview: true }),
  );
  await clickExactText(
    page,
    '[data-testid="workspace-file-tree-panel"] button',
    "返回任务",
  );
  await page.evaluate(`(async () => {
    const row = document.querySelector(${JSON.stringify(projectSelector)});
    const panel = row?.closest('[aria-hidden]');
    if (!panel) throw new Error("原项目面板未显示。");
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
    await new Promise(requestAnimationFrame);
  })()`);
}

async function typeTaskDraft(page: OriginalSessionBrowser, draft: string) {
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
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
}

async function openCreationEditor(page: OriginalSessionBrowser) {
  await page.evaluate(`(() => {
    window.__projectCreationPublicState = {
      input: document.querySelector(${JSON.stringify(inputSelector)}),
      preview: document.querySelector('[data-testid="preview-pane"]'),
      tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
    };
  })()`);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="project-add"]',
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(nameSelector)});
        return Boolean(input?.closest('[role="dialog"]') && !input.disabled);
      })()`),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
  await waitForDialogTarget(page, nameSelector);
}

async function closeCreationResources(
  resources: {
    fixture: HttpFixture;
    model: Model | undefined;
    host: Host | undefined;
    browser: OriginalSessionBrowser | undefined;
    createdProjectIds: Set<string>;
  },
  failures: unknown[],
) {
  const { fixture, model, host, browser, createdProjectIds } = resources;
  for (const close of [
    () => browser?.close(),
    async () => {
      if (!host) return;
      for (const id of createdProjectIds) {
        const deleted = await host.client.request(
          `/api/projects/${id}`,
          undefined,
          "DELETE",
        );
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      }
    },
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

function projectRootRow(path: string) {
  return `[data-testid="virtual-project-root-row"]:has([data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}])`;
}

async function chooseProjectRoot(page: OriginalSessionBrowser, root: string) {
  const browseSelector = '[data-testid="virtual-project-directory-browser"]';
  const pathSelector = `${browseSelector} input[placeholder="输入路径"]`;
  const confirmSelector = `${browseSelector} [data-testid="directory-browser-confirm"]`;
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="virtual-project-browse"]',
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(pathSelector)});
        const confirm = document.querySelector(${JSON.stringify(confirmSelector)});
        return Boolean(input?.value && confirm && !confirm.disabled);
      })()`),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: pathSelector });
  await selectAll(page);
  await typeText(page.cdp, page.target.sessionId, root);
  await clickExactText(page, `${browseSelector} button`, "前往");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const browser = document.querySelector(${JSON.stringify(browseSelector)});
        const input = browser?.querySelector('input[placeholder="输入路径"]');
        const confirm = browser?.querySelector('[data-testid="directory-browser-confirm"]');
        return {
          path: input?.value,
          ready: Boolean(confirm && !confirm.disabled),
          realDirectory: Array.from(browser?.querySelectorAll('button') ?? []).some(button => button.textContent.trim() === '真实可浏览子目录'),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ path: root, ready: true, realDirectory: true }),
  );
  await clickOn(page.cdp, page.target.sessionId, { selector: confirmSelector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(`${projectRootRow(root)} [data-testid="virtual-project-root-name"]`)})?.getAttribute('title')`,
      ),
    ).toBe(root),
  );
}

async function confirmProjectCreation(
  { page, readProjects, projectsBefore }: CreationPageCheck,
  roots: string[],
) {
  expect(await readProjects()).toEqual(projectsBefore);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="virtual-project-save"]',
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
        return {
          paths: Array.from(dialog?.querySelectorAll('[data-testid="project-folder-trust-path"]') ?? [], path => path.textContent),
          cancelFocused: document.activeElement === dialog?.querySelector('[data-testid="project-folder-trust-cancel"]'),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ paths: roots, cancelFocused: true }),
  );
  expect(await readProjects()).toEqual(projectsBefore);
  await waitForDialogTarget(
    page,
    '[data-testid="project-folder-trust-confirm"]',
  );
  const beforeConfirm = await vi.waitFor(async () => {
    const surface = await readCreationSurface(page);
    expect(surface.trust, JSON.stringify(surface)).toMatchObject({
      present: true,
      confirmVisible: true,
      confirmDisabled: false,
      confirmContainsHit: true,
    });
    return surface;
  });
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="project-folder-trust-confirm"]',
  });
  await vi.waitFor(async () => {
    const afterConfirm = await readCreationSurface(page);
    expect(
      afterConfirm.formClosed,
      JSON.stringify({
        beforeConfirm,
        afterConfirm,
        pageErrors: page.pageErrors,
      }),
    ).toBe(true);
  });
}

async function expectCreatedProject(
  {
    session,
    readProjects,
    projectsBefore,
    recordCreatedProject,
  }: CreationPageCheck,
  expected: {
    name: string;
    firstRoot: string;
    primaryRoot: string;
    writableRoot: string;
  },
) {
  const { name, firstRoot, primaryRoot, writableRoot } = expected;
  const projectsAfter = await readProjects();
  const oldIds = new Set(projectsBefore.map((project) => project.id));
  const created = projectsAfter.filter((project) => !oldIds.has(project.id));
  expect(projectsAfter).toHaveLength(projectsBefore.length + 1);
  expect(created).toHaveLength(1);
  const saved = created[0];
  if (!saved) throw new Error("真实项目列表缺少刚创建的项目。");
  recordCreatedProject(saved.id);
  expect(saved).toMatchObject({
    hostId: "local",
    name,
    revision: 0,
    roots: [
      { rootPath: primaryRoot, position: 0, isPrimary: true },
      {
        rootPath: firstRoot,
        position: 1,
        isPrimary: false,
        access: "read-only",
      },
      {
        rootPath: writableRoot,
        position: 2,
        isPrimary: false,
        access: "read-write",
      },
    ],
  });
  expect(saved.roots).toHaveLength(3);
  expect(projectsAfter.filter((project) => project.name === name)).toHaveLength(
    1,
  );
  const listed = await session.client.request("/api/projects?kind=code");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const listedProjects = projectListResponseSchema.parse(listed.body).projects;
  expect(listedProjects.filter((project) => project.id === saved.id)).toEqual([
    expect.objectContaining({
      id: saved.id,
      name,
      kind: "code",
      workDir: primaryRoot,
      enabledModes: ["code"],
    }),
  ]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目创建表单的原Root公共 integration",
  () => {
    const checkWithOriginalPage = async (
      run: (context: CreationPageCheck) => Promise<void>,
      options: CreationPageOptions,
    ) => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<HttpFixture>;
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
      const createdProjectIds = new Set<string>();
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const session = host;
        const readProjects = () => readProjectDirectory(session);
        const readScope = () => readTaskScope(session);
        const { previewName, previewText, draft } = options;
        const previewPath = join(session.workspacePath, previewName);
        await writeFile(previewPath, previewText, "utf8");
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
        await openTaskPreview(page, session, previewName);
        await typeTaskDraft(page, draft);
        const projectsBefore = await readProjects();
        const scopeBefore = await readScope();
        const sessionBefore = protocol.conversationSnapshotSchema.parse(
          await session.snapshot(),
        );
        await openCreationEditor(page);
        await run({
          page,
          session,
          model,
          previewName,
          draft,
          projectsBefore,
          scopeBefore,
          sessionBefore,
          readProjects,
          readScope,
          recordCreatedProject: (id) => {
            createdProjectIds.add(id);
          },
        });
      } catch (error) {
        failures.push(error);
      } finally {
        await closeCreationResources(
          { fixture, model, host, browser, createdProjectIds },
          failures,
        );
      }
      if (failures.length)
        throw new AggregateError(failures, "原项目创建验证或清理失败", {
          cause: failures[0],
        });
    };

    it(
      "原新建项目表单取消后不新增项目，当前Task、正文草稿及预览内容目标保持",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, projectsBefore, readProjects } = context;
            await clickOn(page.cdp, page.target.sessionId, {
              selector: nameSelector,
            });
            await selectAll(page);
            const cancelledName = "取消前编辑的项目名称";
            await typeText(page.cdp, page.target.sessionId, cancelledName);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                ),
              ).toBe(cancelledName),
            );
            await clickExactText(page, '[role="dialog"] button', "取消");
            expect(await readProjects()).toEqual(projectsBefore);
            await expectTaskPreserved(context);
          },
          {
            previewName: "创建项目取消保留内容.txt",
            previewText: "取消项目创建保留当前内容\n",
            draft: "取消项目创建期间保留的正文草稿",
          },
        ),
      180_000,
    );

    it(
      "原创建表单确认多目录与权限后只新增一个项目，当前Task、正文草稿及预览内容目标保持",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, session } = context;
            const firstRoot = join(session.workspacePath, "创建源目录甲");
            const primaryRoot = join(session.workspacePath, "创建源目录乙");
            const writableRoot = join(session.workspacePath, "创建源目录丙");
            const roots = [firstRoot, primaryRoot, writableRoot];
            await Promise.all(
              roots.map((root) =>
                mkdir(join(root, "真实可浏览子目录"), { recursive: true }),
              ),
            );
            const createdName = "原创建表单多目录项目";
            await clickOn(page.cdp, page.target.sessionId, {
              selector: nameSelector,
            });
            await selectAll(page);
            await typeText(page.cdp, page.target.sessionId, createdName);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                ),
              ).toBe(createdName),
            );
            for (const root of roots) await chooseProjectRoot(page, root);
            await clickOn(page.cdp, page.target.sessionId, {
              selector: `${projectRootRow(primaryRoot)} [data-testid="virtual-project-set-primary"]`,
            });
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(`${projectRootRow(primaryRoot)} [data-testid="virtual-project-primary"]`)})?.textContent`,
                ),
              ).toBe("主要"),
            );
            const saveSelector = '[data-testid="virtual-project-save"]';
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(saveSelector)})?.disabled`,
              ),
            ).toBe(true);
            for (const { root, access } of [
              { root: firstRoot, access: "只读" },
              { root: writableRoot, access: "可写" },
            ]) {
              const selector = `${projectRootRow(root)} [data-testid="virtual-project-root-access"]`;
              await clickOn(page.cdp, page.target.sessionId, { selector });
              await clickExactText(page, '[role="option"]', access);
              await vi.waitFor(async () =>
                expect(
                  await page.evaluate(
                    `document.querySelector(${JSON.stringify(selector)})?.textContent`,
                  ),
                ).toBe(access),
              );
            }
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(saveSelector)})?.disabled`,
                ),
              ).toBe(false),
            );
            await confirmProjectCreation(context, roots);
            await expectCreatedProject(context, {
              name: createdName,
              firstRoot,
              primaryRoot,
              writableRoot,
            });
            await expectTaskPreserved(context);
          },
          {
            previewName: "创建项目保存保留内容.txt",
            previewText: "保存项目保留当前内容\n",
            draft: "保存项目创建期间保留的正文草稿",
          },
        ),
      180_000,
    );
  },
);
