// @vitest-environment node
import { randomUUID } from "node:crypto";
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
  selectSidebarView,
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

async function readDirectoryReuseDiagnostics(page: OriginalSessionBrowser) {
  const surface = await readCreationSurface(page);
  const observed = await page.evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'), dialog => ({
      id: dialog.id,
      title: dialog.querySelector('[data-slot="dialog-title"]')?.textContent,
      visible: dialog.checkVisibility(),
      state: dialog.getAttribute('data-state'),
      ariaHidden: dialog.getAttribute('aria-hidden'),
      buttons: Array.from(dialog.querySelectorAll('button'), button => ({
        text: button.textContent.trim(),
        disabled: button.disabled,
        visible: button.checkVisibility(),
        testId: button.getAttribute('data-testid'),
      })),
    }));
    const responseTimings = performance.getEntriesByType('resource')
      .filter(entry => new URL(entry.name).pathname.startsWith('/api/'))
      .map(entry => ({
        path: new URL(entry.name).pathname,
        startAtUnixMs: performance.timeOrigin + entry.startTime,
        requestStartAtUnixMs: entry.requestStart > 0 ? performance.timeOrigin + entry.requestStart : null,
        responseStartAtUnixMs: entry.responseStart > 0 ? performance.timeOrigin + entry.responseStart : null,
        responseEndAtUnixMs: entry.responseEnd > 0 ? performance.timeOrigin + entry.responseEnd : null,
        durationMs: entry.duration,
        waitForResponseMs: entry.requestStart > 0 && entry.responseStart >= entry.requestStart
          ? entry.responseStart - entry.requestStart : null,
        responseDownloadMs: entry.responseStart > 0 && entry.responseEnd >= entry.responseStart
          ? entry.responseEnd - entry.responseStart : null,
        nextHopProtocol: entry.nextHopProtocol,
      }));
    return {
      observedAtUnixMs: Date.now(),
      timeOriginUnixMs: performance.timeOrigin,
      elapsedMs: performance.now(),
      dialogs,
      responseTimings,
    };
  })()`);
  const pending = structuredClone(
    page.requests.filter(
      (request) =>
        request !== null &&
        typeof request === "object" &&
        "state" in request &&
        request.state === "pending",
    ),
  );
  return { surface, observed, pending, pageErrors: page.pageErrors };
}

async function expectTaskPreserved(
  {
    page,
    session,
    model,
    previewName,
    draft,
    scopeBefore,
    sessionBefore,
    readScope,
  }: CreationPageCheck,
  diagnostics?: () => Promise<unknown>,
) {
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
      JSON.stringify(diagnostics ? await diagnostics() : page.pageErrors),
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
  await selectSidebarView(page, "projects");
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
  const treeSelector = `${projectSelector} [data-testid="virtual-project-files"]`;
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
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(
          `document.querySelectorAll(${JSON.stringify(fileSelector)}).length`,
        ),
      ).toBe(1),
    { timeout: 30_000 },
  ); // 等待真实项目文件读取及原目录树显示。
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
    selector: '[data-testid="virtual-project-add"]',
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
  // 真实目录读取可能超过默认的一秒轮询期限；仍等待原页面完成读取。
  await vi.waitFor(
    async () =>
      expect(
        await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(pathSelector)});
          const confirm = document.querySelector(${JSON.stringify(confirmSelector)});
          return Boolean(input?.value && confirm && !confirm.disabled);
        })()`),
        JSON.stringify({
          pageErrors: page.pageErrors,
          requests: page.requests,
          browser: await page.evaluate(`(() => {
            const browser = document.querySelector(${JSON.stringify(browseSelector)});
            const input = browser?.querySelector('input[placeholder="输入路径"]');
            const confirm = browser?.querySelector('[data-testid="directory-browser-confirm"]');
            return {
              visible: browser?.checkVisibility(),
              path: input?.value,
              confirmDisabled: confirm?.disabled,
              text: browser?.textContent?.slice(0, 1200),
            };
          })()`),
        }),
      ).toBe(true),
    { timeout: 30_000 },
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
  context: CreationPageCheck,
  roots: string[],
) {
  const { page, readProjects, projectsBefore } = context;
  expect(await readProjects()).toEqual(projectsBefore);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="virtual-project-save"]',
  });
  await confirmProjectFolders(context, roots);
}

async function confirmProjectFolders(
  { page, readProjects, projectsBefore }: CreationPageCheck,
  roots: string[],
) {
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

async function expectIndependentProject(
  {
    session,
    readProjects,
    projectsBefore,
    recordCreatedProject,
  }: CreationPageCheck,
  expected: {
    name: string;
    primaryRoot: string;
    readOnlyRoot: string;
    publicBefore: ReturnType<typeof projectListResponseSchema.parse>;
  },
) {
  const { name, primaryRoot, readOnlyRoot, publicBefore } = expected;
  const after = await readProjects();
  const oldIds = new Set(projectsBefore.map((project) => project.id));
  const created = after.filter((project) => !oldIds.has(project.id));
  expect(after).toHaveLength(projectsBefore.length + 1);
  expect(created).toHaveLength(1);
  const saved = created[0];
  if (!saved) throw new Error("真实项目列表缺少独立创建的项目。");
  recordCreatedProject(saved.id);
  expect(after.filter((project) => oldIds.has(project.id))).toEqual(
    projectsBefore,
  );
  expect(saved).toMatchObject({ hostId: "local", name, revision: 0 });
  expect(saved.roots).toEqual([
    { rootPath: primaryRoot, position: 0, isPrimary: true },
    {
      rootPath: readOnlyRoot,
      position: 1,
      isPrimary: false,
      access: "read-only",
    },
  ]);
  const listed = await session.client.request("/api/projects?kind=code");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const projects = projectListResponseSchema.parse(listed.body).projects;
  expect(projects).toHaveLength(publicBefore.projects.length + 1);
  expect(projects.filter((project) => oldIds.has(project.id))).toEqual(
    publicBefore.projects,
  );
  expect(projects.filter((project) => project.id === saved.id)).toEqual([
    expect.objectContaining({
      id: saved.id,
      name,
      kind: "code",
      workDir: primaryRoot,
      additionalDirectories: [{ path: readOnlyRoot, access: "read-only" }],
      enabledModes: ["code"],
    }),
  ]);
}

async function expectProjectSaveOnce(
  page: OriginalSessionBrowser,
  baseline: ReadonlySet<unknown>,
) {
  await vi.waitFor(() => {
    const saves = page.requests.filter(
      (request) =>
        !baseline.has(request) &&
        request !== null &&
        typeof request === "object" &&
        "service" in request &&
        request.service === "project" &&
        "method" in request &&
        request.method === "saveProject",
    );
    expect(saves).toEqual([
      expect.objectContaining({
        path: "/api/code-ui/rpc",
        httpMethod: "POST",
        service: "project",
        method: "saveProject",
        status: 200,
        state: "finished",
      }),
    ]);
  });
}

async function waitForDirectoryChoice(
  page: OriginalSessionBrowser,
  projectName: string,
) {
  const selector = await vi.waitFor(async () => {
    const state = await page.evaluate<{
      selector: string | null;
      buttons: string[];
      folderTrust: boolean;
    }>(`(() => {
      const title = Array.from(document.querySelectorAll('[data-slot="dialog-title"]'))
        .find(element => element.textContent.trim() === '目录已关联项目');
      const dialog = title?.closest('[role="dialog"]');
      return {
        selector: dialog?.id ? '[role="dialog"][id=' + JSON.stringify(dialog.id) + ']' : null,
        buttons: Array.from(dialog?.querySelectorAll('button') ?? [], button => button.textContent.trim()),
        folderTrust: Boolean(document.querySelector('[data-testid="project-folder-trust-dialog"]')),
      };
    })()`);
    expect(
      state.buttons,
      JSON.stringify({ state, pageErrors: page.pageErrors }),
    ).toEqual(expect.arrayContaining([projectName, "独立创建", "取消"]));
    expect(state.folderTrust).toBe(false);
    if (!state.selector) throw new Error("原目录项目选择框未显示。");
    return state.selector;
  });
  await page.evaluate(`(async () => {
    const dialog = document.querySelector(${JSON.stringify(selector)});
    if (!dialog) throw new Error("原目录项目选择框已关闭。");
    const sibling = dialog.previousElementSibling;
    const overlay = sibling?.matches('[data-slot="dialog-overlay"]') ? sibling : null;
    await Promise.all([
      ...dialog.getAnimations({ subtree: true }),
      ...(overlay?.getAnimations({ subtree: true }) ?? []),
    ].map(animation => animation.finished));
    await new Promise(requestAnimationFrame);
  })()`);
  return selector;
}

type ProjectResponseTarget = "directory-candidates" | "project.readProjects";

function matchesPausedProjectResponse(
  page: OriginalSessionBrowser,
  request: unknown,
  networkId: unknown,
  target: ProjectResponseTarget,
) {
  if (!request || typeof request !== "object" || !("method" in request))
    return false;
  if (target === "directory-candidates") return request.method === "GET";
  return page.requests.some(
    (fact) =>
      fact !== null &&
      typeof fact === "object" &&
      "requestId" in fact &&
      "service" in fact &&
      "method" in fact &&
      fact.requestId === networkId &&
      fact.service === "project" &&
      fact.method === "readProjects",
  );
}

async function withPausedProjectResponse(
  page: OriginalSessionBrowser,
  run: (response: {
    waitForResponse(): Promise<string>;
    release(): Promise<void>;
  }) => Promise<void>,
  target: ProjectResponseTarget = "directory-candidates",
) {
  let paused:
    | { requestId: string; networkId: string; status: number }
    | undefined;
  let enabled = true;
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  const releasePaused = page.cdp.on(
    "Fetch.requestPaused",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const matches = matchesPausedProjectResponse(
        page,
        params.request,
        params.networkId,
        target,
      );
      if (
        (!paused || target === "project.readProjects") &&
        params.responseStatusCode === 200 &&
        typeof params.networkId === "string" &&
        matches
      ) {
        paused = {
          requestId: params.requestId,
          networkId: params.networkId,
          status: params.responseStatusCode,
        };
        return;
      }
      const operation = page.cdp.send(
        "Fetch.continueResponse",
        { requestId: params.requestId },
        page.target.sessionId,
      );
      continuations.push(operation);
      void operation.catch((error: unknown) => failures.push(error));
    },
  );
  const release = async () => {
    if (!enabled) return;
    await page.cdp.send("Fetch.disable", {}, page.target.sessionId);
    enabled = false;
    await Promise.allSettled(continuations);
  };
  try {
    await page.cdp.send(
      "Fetch.enable",
      {
        patterns: [
          {
            urlPattern:
              target === "directory-candidates"
                ? "*/api/projects/directory-candidates*"
                : "*/api/code-ui/rpc",
            requestStage: "Response",
          },
        ],
      },
      page.target.sessionId,
    );
    await run({
      async waitForResponse() {
        await vi.waitFor(() => {
          expect(failures).toEqual([]);
          expect(paused).toMatchObject({ status: 200 });
        });
        if (!paused) throw new Error("未暂停原项目读取响应。");
        return paused.networkId;
      },
      release,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
    releasePaused();
    await Promise.allSettled(continuations);
  }
  if (failures.length)
    throw new AggregateError(failures, "原项目读取响应暂停或清理失败", {
      cause: failures[0],
    });
}

async function expectOriginalProjects(
  { session, readProjects, projectsBefore }: CreationPageCheck,
  publicBefore: ReturnType<typeof projectListResponseSchema.parse>,
) {
  expect(await readProjects()).toEqual(projectsBefore);
  const listed = await session.client.request("/api/projects?kind=code");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(projectListResponseSchema.parse(listed.body)).toEqual(publicBefore);
}

function expectNoProjectWrites(
  page: OriginalSessionBrowser,
  baseline: ReadonlySet<unknown>,
) {
  const observed = page.requests.filter((request) => !baseline.has(request));
  expect(observed).not.toContainEqual(
    expect.objectContaining({ service: "project", method: "saveProject" }),
  );
  expect(observed).not.toContainEqual(
    expect.objectContaining({
      path: expect.stringMatching(/^\/api\/projects\/[^/]+$/u),
      httpMethod: "PATCH",
    }),
  );
}

async function keepNextCreationPending(
  context: CreationPageCheck,
  releaseOldResponse: () => Promise<void>,
) {
  const { page, session, projectsBefore } = context;
  const existing = projectsBefore.find(
    (project) => project.id === session.projectId,
  );
  if (!existing) throw new Error("真实项目列表缺少当前项目。");
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="virtual-project-add"]',
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(nameSelector)}))`,
      ),
    ).toBe(true),
  );
  await waitForDialogTarget(page, nameSelector);
  const nextName = "旧候选响应之后的创建B";
  await clickOn(page.cdp, page.target.sessionId, { selector: nameSelector });
  await selectAll(page);
  await typeText(page.cdp, page.target.sessionId, nextName);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
      ),
    ).toBe(nextName),
  );
  await chooseProjectRoot(page, session.workspacePath);
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="virtual-project-save"]',
  });
  const choiceSelector = await waitForDirectoryChoice(page, existing.name);
  await releaseOldResponse();
  expect(await context.readProjects()).toEqual(projectsBefore);
  await page.evaluate("new Promise(requestAnimationFrame)");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => ({
        choiceVisible: document.querySelector(${JSON.stringify(choiceSelector)})?.checkVisibility() ?? false,
        name: document.querySelector(${JSON.stringify(nameSelector)})?.value,
        saveDisabled: document.querySelector('[data-testid="virtual-project-save"]')?.disabled,
        folderTrust: Boolean(document.querySelector('[data-testid="project-folder-trust-dialog"]')),
      }))()`),
    ).toEqual({
      choiceVisible: true,
      name: nextName,
      saveDisabled: true,
      folderTrust: false,
    }),
  );
  await clickExactText(page, `${choiceSelector} button`, "取消");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => ({
        choiceClosed: document.querySelector(${JSON.stringify(choiceSelector)}) === null,
        name: document.querySelector(${JSON.stringify(nameSelector)})?.value,
        saveDisabled: document.querySelector('[data-testid="virtual-project-save"]')?.disabled,
      }))()`),
    ).toEqual({ choiceClosed: true, name: nextName, saveDisabled: false }),
  );
  await clickExactText(
    page,
    '[role="dialog"]:has([data-testid="virtual-project-name"]) button',
    "Close",
  );
}

async function withIndependentDirectoryTarget(
  session: Host,
  run: (target: CodeProjectEditorProject) => Promise<void>,
) {
  let targetId: string | undefined;
  const failures: unknown[] = [];
  try {
    const created = await session.client.request("/api/code-ui/rpc", {
      service: "project",
      method: "saveProject",
      args: [
        {
          creationId: randomUUID(),
          kind: "code",
          name: "选择期间待归档的同目录项目",
          roots: [session.workspacePath],
          primaryRoot: session.workspacePath,
          rootPermissions: {},
          directoryChoice: "independent",
        },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const target = codeProjectEditorProjectSchema.parse(created.body.result);
    targetId = target.id;
    expect(target.id).not.toBe(session.projectId);
    expect(target.roots).toEqual([
      { rootPath: session.workspacePath, position: 0, isPrimary: true },
    ]);
    await run(target);
  } catch (error) {
    failures.push(error);
  } finally {
    if (targetId) {
      try {
        const archived = await session.client.request(
          `/api/projects/${targetId}`,
          undefined,
          "DELETE",
        );
        expect(
          [204, 404],
          JSON.stringify({ status: archived.status, body: archived.body }),
        ).toContain(archived.status);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "同目录候选归档验证或清理失败", {
      cause: failures[0],
    });
}

async function expectArchivedChoiceRejected(
  page: OriginalSessionBrowser,
  choiceSelector: string,
  name: string,
  root: string,
) {
  await vi.waitFor(async () => {
    const state = await page.evaluate<Record<string, unknown>>(`(() => {
      const name = document.querySelector(${JSON.stringify(nameSelector)});
      const editor = name?.closest('[role="dialog"]');
      return {
        name: name?.value,
        nameDisabled: name?.disabled,
        roots: Array.from(editor?.querySelectorAll('[data-testid="virtual-project-root-name"]') ?? [], row => row.getAttribute('title')),
        alerts: Array.from(editor?.querySelectorAll('[role="alert"]') ?? [], alert => alert.textContent),
        saveDisabled: editor?.querySelector('[data-testid="virtual-project-save"]')?.disabled,
        choiceClosed: document.querySelector(${JSON.stringify(choiceSelector)}) === null,
        folderTrust: Boolean(document.querySelector('[data-testid="project-folder-trust-dialog"]')),
      };
    })()`);
    expect(
      state,
      JSON.stringify({ state, pageErrors: page.pageErrors }),
    ).toMatchObject({
      name,
      nameDisabled: false,
      roots: [root],
      saveDisabled: false,
      choiceClosed: true,
      folderTrust: false,
    });
    expect(
      state.alerts,
      JSON.stringify({
        state,
        pageErrors: page.pageErrors,
        requests: page.requests,
      }),
    ).toEqual([expect.stringMatching(/项目.*重新选择/u)]);
  });
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

    it(
      "原创建表单明确复用同目录项目后保持项目、当前Task、草稿和内容且不写项目",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, session, projectsBefore, readProjects } = context;
            const existing = projectsBefore.find(
              (project) => project.id === session.projectId,
            );
            if (!existing) throw new Error("真实项目列表缺少当前项目。");
            expect(
              existing.roots.find((root) => root.isPrimary)?.rootPath,
            ).toBe(session.workspacePath);
            const requestBaseline = new Set(page.requests);
            const listBefore = await session.client.request(
              "/api/projects?kind=code",
            );
            expect(listBefore.status, JSON.stringify(listBefore.body)).toBe(
              200,
            );
            const publicProjectsBefore = projectListResponseSchema.parse(
              listBefore.body,
            );
            await mkdir(join(session.workspacePath, "真实可浏览子目录"), {
              recursive: true,
            });
            const proposedName = "复用同目录时保留原项目名称";
            await clickOn(page.cdp, page.target.sessionId, {
              selector: nameSelector,
            });
            await selectAll(page);
            await typeText(page.cdp, page.target.sessionId, proposedName);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                ),
              ).toBe(proposedName),
            );
            await chooseProjectRoot(page, session.workspacePath);
            await clickOn(page.cdp, page.target.sessionId, {
              selector: '[data-testid="virtual-project-save"]',
            });
            const choiceSelector = await waitForDirectoryChoice(
              page,
              existing.name,
            );
            await withPausedProjectResponse(
              page,
              async () => {
                await clickExactText(
                  page,
                  `${choiceSelector} button`,
                  existing.name,
                );
                await expectTaskPreserved(context, () =>
                  readDirectoryReuseDiagnostics(page),
                );
              },
              "project.readProjects",
            );
            expect(await readProjects()).toEqual(projectsBefore);
            const listAfter = await session.client.request(
              "/api/projects?kind=code",
            );
            expect(listAfter.status, JSON.stringify(listAfter.body)).toBe(200);
            expect(projectListResponseSchema.parse(listAfter.body)).toEqual(
              publicProjectsBefore,
            );
            const observed = page.requests.filter(
              (request) => !requestBaseline.has(request),
            );
            expect(observed).toContainEqual(
              expect.objectContaining({
                path: "/api/projects/directory-candidates",
                httpMethod: "GET",
                status: 200,
              }),
            );
            expect(observed).not.toContainEqual(
              expect.objectContaining({
                service: "project",
                method: "saveProject",
              }),
            );
            expect(observed).not.toContainEqual(
              expect.objectContaining({
                path: expect.stringMatching(/^\/api\/projects\/[^/]+$/u),
                httpMethod: "PATCH",
              }),
            );
          },
          {
            previewName: "同目录复用保留内容.txt",
            previewText: "复用项目保留当前内容\n",
            draft: "同目录项目复用期间保留的正文草稿",
          },
        ),
      180_000,
    );

    it(
      "原创建表单明确独立创建同目录项目后保存权限且保持原项目和当前Task内容",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, session, projectsBefore } = context;
            const existing = projectsBefore.find(
              (project) => project.id === session.projectId,
            );
            if (!existing) throw new Error("真实项目列表缺少当前项目。");
            const primaryRoot = session.workspacePath;
            expect(
              existing.roots.find((root) => root.isPrimary)?.rootPath,
            ).toBe(primaryRoot);
            const requestBaseline = new Set(page.requests);
            const listed = await session.client.request(
              "/api/projects?kind=code",
            );
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            const publicBefore = projectListResponseSchema.parse(listed.body);
            const readOnlyRoot = join(primaryRoot, "同目录独立只读目录");
            const roots = [primaryRoot, readOnlyRoot];
            await Promise.all(
              roots.map((root) =>
                mkdir(join(root, "真实可浏览子目录"), { recursive: true }),
              ),
            );
            const name = "明确独立同目录项目";
            await clickOn(page.cdp, page.target.sessionId, {
              selector: nameSelector,
            });
            await selectAll(page);
            await typeText(page.cdp, page.target.sessionId, name);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                ),
              ).toBe(name),
            );
            for (const root of roots) await chooseProjectRoot(page, root);
            const accessSelector = `${projectRootRow(readOnlyRoot)} [data-testid="virtual-project-root-access"]`;
            await clickOn(page.cdp, page.target.sessionId, {
              selector: accessSelector,
            });
            await clickExactText(page, '[role="option"]', "只读");
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(accessSelector)})?.textContent`,
                ),
              ).toBe("只读"),
            );
            await clickOn(page.cdp, page.target.sessionId, {
              selector: '[data-testid="virtual-project-save"]',
            });
            const choiceSelector = await waitForDirectoryChoice(
              page,
              existing.name,
            );
            await clickExactText(page, `${choiceSelector} button`, "独立创建");
            await confirmProjectFolders(context, roots);
            await expectIndependentProject(context, {
              name,
              primaryRoot,
              readOnlyRoot,
              publicBefore,
            });
            await expectTaskPreserved(context);
            await expectProjectSaveOnce(page, requestBaseline);
          },
          {
            previewName: "同目录独立创建保留内容.txt",
            previewText: "独立创建项目保留当前内容\n",
            draft: "同目录独立创建期间保留的正文草稿",
          },
        ),
      180_000,
    );

    it(
      "候选读取中关闭会取消原响应，迟到结果不影响下一次创建选择",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, session } = context;
            const baseline = new Set(page.requests);
            const listed = await session.client.request(
              "/api/projects?kind=code",
            );
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            const publicBefore = projectListResponseSchema.parse(listed.body);
            await mkdir(join(session.workspacePath, "真实可浏览子目录"), {
              recursive: true,
            });
            await clickOn(page.cdp, page.target.sessionId, {
              selector: nameSelector,
            });
            await selectAll(page);
            const firstName = "候选读取期间关闭的创建A";
            await typeText(page.cdp, page.target.sessionId, firstName);
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                ),
              ).toBe(firstName),
            );
            await chooseProjectRoot(page, session.workspacePath);
            await withPausedProjectResponse(page, async (response) => {
              await clickOn(page.cdp, page.target.sessionId, {
                selector: '[data-testid="virtual-project-save"]',
              });
              const networkId = await response.waitForResponse();
              await clickExactText(
                page,
                '[role="dialog"]:has([data-testid="virtual-project-name"]) button',
                "Close",
              );
              await expectTaskPreserved(context, () =>
                readDirectoryReuseDiagnostics(page),
              );
              await vi.waitFor(() => {
                expect(page.requests).toContainEqual(
                  expect.objectContaining({
                    requestId: networkId,
                    path: "/api/projects/directory-candidates",
                    httpMethod: "GET",
                    state: "failed",
                    error: "net::ERR_ABORTED",
                  }),
                );
                expect(page.pageErrors).toContainEqual(
                  expect.objectContaining({
                    requestId: networkId,
                    canceled: true,
                  }),
                );
              });
              await expectOriginalProjects(context, publicBefore);
              expectNoProjectWrites(page, baseline);
              await keepNextCreationPending(context, response.release);
              await expectTaskPreserved(context);
              await expectOriginalProjects(context, publicBefore);
              expectNoProjectWrites(page, baseline);
            });
          },
          {
            previewName: "候选取消与迟到结果保留内容.txt",
            previewText: "候选读取取消保留当前内容\n",
            draft: "候选读取取消和下一次创建期间保留的正文草稿",
          },
        ),
      180_000,
    );

    it(
      "选择期间目标项目归档后旧候选不可复用，保留表单并保持原项目和当前Task",
      () =>
        checkWithOriginalPage(
          async (context) => {
            const { page, session, readProjects } = context;
            const listed = await session.client.request(
              "/api/projects?kind=code",
            );
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            const publicBefore = projectListResponseSchema.parse(listed.body);
            await withIndependentDirectoryTarget(session, async (target) => {
              expect(await readProjects()).toContainEqual(target);
              const baseline = new Set(page.requests);
              await mkdir(join(session.workspacePath, "真实可浏览子目录"), {
                recursive: true,
              });
              const proposedName = "目标归档后保留的项目名称草稿";
              await clickOn(page.cdp, page.target.sessionId, {
                selector: nameSelector,
              });
              await selectAll(page);
              await typeText(page.cdp, page.target.sessionId, proposedName);
              await vi.waitFor(async () =>
                expect(
                  await page.evaluate(
                    `document.querySelector(${JSON.stringify(nameSelector)})?.value`,
                  ),
                ).toBe(proposedName),
              );
              await chooseProjectRoot(page, session.workspacePath);
              await clickOn(page.cdp, page.target.sessionId, {
                selector: '[data-testid="virtual-project-save"]',
              });
              const choiceSelector = await waitForDirectoryChoice(
                page,
                target.name,
              );
              const archived = await session.client.request(
                `/api/projects/${target.id}`,
                undefined,
                "DELETE",
              );
              expect(archived.status, JSON.stringify(archived.body)).toBe(204);
              await expectOriginalProjects(context, publicBefore);
              await clickExactText(
                page,
                `${choiceSelector} button`,
                target.name,
              );
              await expectArchivedChoiceRejected(
                page,
                choiceSelector,
                proposedName,
                session.workspacePath,
              );
              const unavailable = await session.client.request(
                `/api/projects/${target.id}`,
              );
              expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(
                404,
              );
              await clickExactText(
                page,
                '[role="dialog"]:has([data-testid="virtual-project-name"]) button',
                "Close",
              );
              await expectTaskPreserved(context);
              await expectOriginalProjects(context, publicBefore);
              expectNoProjectWrites(page, baseline);
              expect(
                page.requests.filter((request) => !baseline.has(request)),
              ).toContainEqual(
                expect.objectContaining({
                  path: "/api/projects/directory-candidates",
                  httpMethod: "GET",
                  status: 200,
                }),
              );
            });
          },
          {
            previewName: "归档候选拒绝复用保留内容.txt",
            previewText: "目标归档保留当前内容\n",
            draft: "项目候选归档期间保留的正文草稿",
          },
        ),
      180_000,
    );
  },
);
