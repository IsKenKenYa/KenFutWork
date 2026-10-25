import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeTaskGroup,
  codeTaskGroupStructureSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { expect, vi } from "vitest";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./code-public-browser.fixture.mjs";
import { selectSidebarView } from "./code-public-browser-actions.js";
import type { PublicFixture } from "./code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type HttpFixture = PublicFixture & { origin: string };

export interface TaskGroupPublicPageContext {
  fixture: HttpFixture;
  host: Host;
  model: Model;
  page: OriginalSessionBrowser;
  draft: string;
  previewTitle: string;
  modelRequestCountBefore: number;
  scopeBefore: Awaited<ReturnType<typeof readScope>>;
  snapshotBefore: ReturnType<typeof protocol.conversationSnapshotSchema.parse>;
}

const inputSelector = '[role="textbox"][contenteditable="true"]';
const fixturePath = fileURLToPath(
  new URL(
    "../../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function loadPublicFixtures() {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<HttpFixture>;
  }> = import(fixturePath);
  return Promise.all([
    httpLoading,
    import("../../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../../server/src/features/code-ui/model-stream.fixture.js"),
  ]);
}

async function closeResources(
  resources: {
    browser?: OriginalSessionBrowser | undefined;
    host?: Host | undefined;
    fixture: HttpFixture;
    model?: Model | undefined;
  },
  failures: unknown[],
) {
  for (const close of [
    () => resources.browser?.close(),
    () => resources.host?.dispose(),
    () => resources.fixture.close(),
    () => resources.model?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
}

export async function readGroups(host: Host) {
  const result = await host.client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "read",
    args: [],
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(result.body.result);
}

export async function readScope(host: Host) {
  const result = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(result.body).scope;
}

async function hoverProjectRow(
  page: OriginalSessionBrowser,
  projectSelector: string,
) {
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const element = document.querySelector(${JSON.stringify(projectSelector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center" });
      const panel = element.closest('[aria-hidden]');
      if (panel) await Promise.all(panel.getAnimations().map(animation => animation.finished));
      await new Promise(requestAnimationFrame);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit && element.contains(hit) ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    expect(found, JSON.stringify(page.pageErrors)).not.toBeNull();
    return found;
  });
  if (!point) throw new Error("原项目行尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...point },
    page.target.sessionId,
  );
}

async function openTaskFile(
  page: OriginalSessionBrowser,
  host: Host,
  path: string,
  title: string,
) {
  const projectSelector = `[data-project-id=${JSON.stringify(host.projectId)}]`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id')`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(host.sessionId),
  );
  await selectSidebarView(page, "projects");
  await hoverProjectRow(page, projectSelector);
  const treeButton = `${projectSelector} [data-testid="virtual-project-files"]`;
  await clickOn(page.cdp, page.target.sessionId, { selector: treeButton });
  const fileSelector = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${path}`)}]`;
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
    const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
    return { title: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
      ready: Boolean(document.querySelector('[data-testid="preview-pane"]')) };
  })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ title, ready: true }),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=sidebar]")?.checkVisibility()',
      ),
    ).toBe(true),
  );
}

async function enterGroupView(page: OriginalSessionBrowser, draft: string) {
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  await typeText(page.cdp, page.target.sessionId, draft);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(draft),
  );
  await page.evaluate(`(() => {
    window.__taskGroupPublicBefore = {
      input: document.querySelector(${JSON.stringify(inputSelector)}),
      preview: document.querySelector('[data-testid="preview-pane"]'),
      tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
    };
  })()`);
  await selectSidebarView(page, "grouped");
}

export async function expectContentPreserved({
  page,
  host,
  draft,
  previewTitle,
}: TaskGroupPublicPageContext) {
  expect(
    await page.evaluate(`(() => {
    const before = window.__taskGroupPublicBefore;
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const preview = document.querySelector('[data-testid="preview-pane"]');
    const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
    return {
      inputPreserved: Boolean(input && input === before.input),
      previewPreserved: Boolean(preview && preview === before.preview),
      tabPreserved: Boolean(tab && tab === before.tab),
      draft: input?.textContent,
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      previewTitle: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
    };
  })()`),
    JSON.stringify(page.pageErrors),
  ).toEqual({
    inputPreserved: true,
    previewPreserved: true,
    tabPreserved: true,
    draft,
    taskId: host.sessionId,
    previewTitle,
  });
}

export async function createGroupFromUi({
  page,
  host,
}: TaskGroupPublicPageContext): Promise<CodeTaskGroup> {
  const selector = '[data-testid="sidebar"] button[aria-label="新建分组"]';
  await vi.waitFor(
    async () => {
      expect(
        await page.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility === "visible",
            disabled: button.disabled,
            hit: Boolean(hit && button.contains(hit)),
          };
        })()`),
        JSON.stringify(page.pageErrors),
      ).toEqual({ visible: true, disabled: false, hit: true });
    },
    { timeout: 5_000 },
  ); // 原分组owner完成初次登记和读取后才允许真实点击。
  const before = await readGroups(host);
  const previousIds = new Set(before.groups.map((group) => group.id));
  await clickOn(page.cdp, page.target.sessionId, { selector });
  const created = await vi.waitFor(
    async () => {
      const current = await readGroups(host);
      expect(
        current.groups,
        JSON.stringify({
          pageErrors: page.pageErrors,
          requests: page.requests,
        }),
      ).toHaveLength(before.groups.length + 1);
      return current;
    },
    { timeout: 5_000 },
  ); // 原组件点击、真实RPC与数据库保存的本机等待期限。
  const group = created.groups.find((entry) => !previousIds.has(entry.id));
  if (!group) throw new Error("原界面创建后缺少公开分组结果。");
  expect(created.revision).toBe(before.revision + 1);
  expect(created.order[0]).toEqual({
    type: "group",
    key: group.id,
    sortOrder: 0,
  });
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(
        `document.querySelectorAll('[data-task-group-id=${JSON.stringify(group.id)}]').length`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(1);
  });
  return group;
}

export async function dismissGroupSetup(page: OriginalSessionBrowser) {
  await vi.waitFor(
    async () => {
      await pressKey(page.cdp, page.target.sessionId, "Escape");
      expect(
        await page.evaluate(
          `Array.from(document.querySelectorAll('[data-testid="task-group-title-input"], [role="menu"]')).filter(element => element.checkVisibility()).length`,
        ),
      ).toBe(0);
    },
    { timeout: 5_000 },
  ); // 通过原Escape关闭初始名称与颜色菜单，等待其真实焦点保护结束。
}

export async function withTaskGroupPublicPage(
  work: (context: TaskGroupPublicPageContext) => Promise<void>,
  options: { seedTaskHistory?: boolean } = {},
) {
  const [http, sessions, models] = await loadPublicFixtures();
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
    if (options.seedTaskHistory) {
      const sent = await host.command("sendText", {
        text: "原任务已有的历史消息",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      await model.firstRequest;
      model.finish(0);
      const original = host;
      await vi.waitFor(
        async () => {
          const snapshot = protocol.conversationSnapshotSchema.parse(
            await original.snapshot(),
          );
          expect(snapshot.control.phase).toBe("completedSuccess");
        },
        { timeout: 30_000 },
      ); // 仅等待原Task通过真实模型HTTP完成首条输入。
    }
    const scopeBefore = await readScope(host);
    const snapshotBefore = protocol.conversationSnapshotSchema.parse(
      await host.snapshot(),
    );
    const previewTitle = "分组操作保留内容.txt";
    const previewPath = join(host.workspacePath, previewTitle);
    await writeFile(previewPath, "分组操作保留原内容\n", "utf8");
    browser = await openOriginalSessionBrowser({
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
    });
    await openTaskFile(browser, host, previewPath, previewTitle);
    const draft = "分组整理期间保留的草稿";
    await enterGroupView(browser, draft);
    await work({
      fixture,
      host,
      model,
      page: browser,
      draft,
      previewTitle,
      modelRequestCountBefore: model.requests.length,
      scopeBefore,
      snapshotBefore,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    await closeResources({ browser, host, fixture, model }, failures);
  }
  if (failures.length)
    throw new AggregateError(failures, "原分组界面创建或资源关闭失败", {
      cause: failures[0],
    });
}
