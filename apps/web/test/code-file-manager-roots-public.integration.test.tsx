// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeProjectTreeSchema,
  codeUiViewerScopeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import { observeViewerRequests } from "./setup/code-file-viewer-public.fixture.js";
import {
  clickExactText,
  selectSidebarView,
} from "./setup/code-public-browser-actions.js";
import {
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const paneExpression = `Array.from(document.querySelectorAll('[data-file-manager-pane]')).find(node => node.checkVisibility())`;
const addressSchema = z.object({
  workspacePath: z.string().optional(),
  workspaceIdentity: z.string().optional(),
  path: z.string().optional(),
  rootPath: z.string().optional(),
  paths: z.array(z.string()).optional(),
  viewerScope: codeUiViewerScopeSchema,
});

async function prepareRoots(context: TaskGroupPublicPageContext) {
  const { fixture, host } = context;
  const additionalDirectory = join(fixture.directory, "附加浏览目录");
  await mkdir(additionalDirectory);
  const name = "同名预览.svg";
  await writeFile(
    join(host.workspacePath, name),
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="13"><title>主要目录文件</title></svg>',
  );
  await writeFile(
    join(additionalDirectory, name),
    '<svg xmlns="http://www.w3.org/2000/svg" width="31" height="19"><title>附加目录文件</title></svg>',
  );
  const read = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const project = codeProjectTreeSchema
    .parse(read.body.result)
    .projects.find((entry) => entry.id === host.projectId);
  if (!project) throw new Error("原项目树缺少当前真实项目。");
  const saved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "saveProject",
    args: [
      {
        id: project.id,
        expectedRevision: project.revision,
        roots: [host.workspacePath, additionalDirectory],
        primaryRoot: host.workspacePath,
        rootPermissions: { [additionalDirectory]: "read-only" },
      },
    ],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(await readScope(host)).toEqual(context.scopeBefore);
  const denied = await host.client.request("/api/code-ui/rpc", {
    service: "file",
    method: "readTextFile",
    args: [
      {
        path: join(additionalDirectory, name),
        viewerScope: { kind: "task", taskId: host.sessionId },
      },
    ],
  });
  expect(denied.status, JSON.stringify(denied.body)).toBe(404);
  return { additionalDirectory, name };
}

async function openRoot(
  context: TaskGroupPublicPageContext,
  directory: string,
) {
  const { page, host } = context;
  const previous = await page.evaluate<string | null>(
    'document.querySelector("[data-side-pane-tab-id][data-state=active]")?.getAttribute("data-side-pane-tab-id") ?? null',
  );
  await selectSidebarView(page, "projects");
  const button = `[data-project-id=${JSON.stringify(host.projectId)}] [data-testid="virtual-project-files"]`;
  await clickOn(page.cdp, page.target.sessionId, { selector: button });
  await clickExactText(page, '[role="menuitem"]', `查看文件 · ${directory}`);
  return vi.waitFor(async () => {
    const current = await page.evaluate<string | null>(
      'document.querySelector("[data-side-pane-tab-id][data-state=active]")?.getAttribute("data-side-pane-tab-id") ?? null',
    );
    expect(current).toMatch(/^file-manager:/);
    expect(current).not.toBe(previous);
    if (!current) throw new Error("明确打开目录后缺少原文件标签。");
    return current;
  });
}

async function filePoint(context: TaskGroupPublicPageContext, path: string) {
  const { page } = context;
  const selector = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${path}`)}]`;
  const point = await vi.waitFor(async () => {
    const value = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(async () => {
      const pane = ${paneExpression};
      const row = pane?.querySelector(${JSON.stringify(selector)});
      if (!row) return null;
      row.scrollIntoView({ block: 'center' });
      await new Promise(requestAnimationFrame);
      const rect = row.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && row.contains(hit) ? { x, y } : null;
    })()`);
    expect(value, JSON.stringify(page.pageErrors)).not.toBeNull();
    return value;
  });
  if (!point) throw new Error("当前文件标签未显示该目录的文件。");
  return point;
}

async function openImage(
  context: TaskGroupPublicPageContext,
  path: string,
  width: number,
) {
  const { page } = context;
  const point = await filePoint(context, path);
  await clickOn(page.cdp, page.target.sessionId, point);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
    const pane = ${paneExpression};
    const image = pane?.querySelector('[data-testid="preview-pane"] img');
    return image && image.complete ? image.naturalWidth : null;
  })()`),
      JSON.stringify(page.pageErrors),
    ).toBe(width),
  );
}

async function expectHostAddress(
  context: TaskGroupPublicPageContext,
  observation: ReturnType<typeof observeViewerRequests>,
  directory: string,
) {
  const verify = () => {
    const git = [...observation.requests.values()].filter(
      (request) =>
        request.service === "git" &&
        request.method === "getIgnoredPaths" &&
        addressSchema
          .parse(request.args[0])
          .paths?.includes(join(directory, "同名预览.svg")),
    );
    expect(
      git,
      JSON.stringify([...observation.requests.values()]),
    ).not.toHaveLength(0);
    const expected = {
      workspacePath: context.host.workspacePath,
      viewerScope: { kind: "project", projectId: context.host.projectId },
    };
    for (const request of git) {
      const input = addressSchema.parse(request.args[0]);
      expect(input, JSON.stringify(request)).toMatchObject(expected);
      if (input.workspaceIdentity)
        expect(input.workspaceIdentity).toBe(
          JSON.stringify([context.host.projectId, context.host.workspacePath]),
        );
    }
    const watch = [...observation.requests.values()].find(
      (request) =>
        request.service === "file-watcher" &&
        request.method === "watch" &&
        addressSchema.parse(request.args[0]).path === directory,
    );
    expect(
      watch,
      JSON.stringify([...observation.requests.values()]),
    ).not.toBeUndefined();
    expect(watch?.status).toBe(200);
    expect(addressSchema.parse(watch?.args[0]).viewerScope).toEqual(
      expected.viewerScope,
    );
  };
  await vi.waitFor(verify, { timeout: 5_000 }); // 等待原组件真实目录和watcher回包，不重发业务操作。
}

async function searchInRoot(
  context: TaskGroupPublicPageContext,
  observation: ReturnType<typeof observeViewerRequests>,
  directory: string,
) {
  const { page, host } = context;
  const point = await page.evaluate<{
    x: number;
    y: number;
  }>(`(() => {
    const input = (${paneExpression})?.querySelector('input');
    if (!input) throw new Error('原文件搜索输入框未显示');
    const rect = input.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await clickOn(page.cdp, page.target.sessionId, point);
  await typeText(page.cdp, page.target.sessionId, "同名");
  const verify = () => {
    const request = [...observation.requests.values()].find(
      (entry) =>
        entry.service === "file" &&
        entry.method === "listWorkspaceFilesLength" &&
        addressSchema.parse(entry.args[0]).rootPath === directory,
    );
    expect(
      request,
      JSON.stringify([...observation.requests.values()]),
    ).not.toBeUndefined();
    expect(request?.status).toBe(200);
    expect(addressSchema.parse(request?.args[0]).viewerScope).toEqual({
      kind: "project",
      projectId: host.projectId,
    });
  };
  await vi.waitFor(verify, { timeout: 5_000 });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原FileManager多目录与真实宿主身份 integration",
  () => {
    it("两个目录的同名文件分别导航，浏览附加目录保留主目录身份与原Task权限", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { host, page } = context;
        const { additionalDirectory, name } = await prepareRoots(context);
        const observation = observeViewerRequests(page);
        try {
          const extraTab = await openRoot(context, additionalDirectory);
          await expectHostAddress(context, observation, additionalDirectory);
          await searchInRoot(context, observation, additionalDirectory);
          await openImage(context, join(additionalDirectory, name), 31);
          const mainTab = await openRoot(context, host.workspacePath);
          await openImage(context, join(host.workspacePath, name), 17);
          expect(mainTab).not.toBe(extraTab);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: `[data-side-pane-tab-id=${JSON.stringify(extraTab)}]`,
          });
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
            const image = (${paneExpression})?.querySelector('[data-testid="preview-pane"] img');
            return image?.naturalWidth;
          })()`),
            ).toBe(31),
          );
          expect(await readScope(host)).toEqual(context.scopeBefore);
          expect(
            await page.evaluate(`(() => {
            const input = document.querySelector('[role="textbox"][contenteditable="true"]');
            return { sameInput: input === window.__taskGroupPublicBefore.input, draft: input?.textContent,
              taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') };
          })()`),
          ).toEqual({
            sameInput: true,
            draft: context.draft,
            taskId: host.sessionId,
          });
          const current = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          expect(current.rows.window).toEqual(
            context.snapshotBefore.rows.window,
          );
          expect(context.model.requests).toHaveLength(
            context.modelRequestCountBefore,
          );
        } finally {
          observation.dispose();
        }
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 两个真实目录、原Root、多标签及独占PostgreSQL与浏览器关闭期限。

    it("附加目录文件复制可定位的完整路径，不引用主目录中的同名文件", async () => {
      const verify = async (context: TaskGroupPublicPageContext) => {
        const { page, host } = context;
        const { additionalDirectory, name } = await prepareRoots(context);
        await openRoot(context, additionalDirectory);
        const path = join(additionalDirectory, name);
        const point = await filePoint(context, path);
        const origin = await page.evaluate<string>("location.origin");
        await page.cdp.send("Browser.grantPermissions", {
          origin,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        await page.cdp.send("Page.bringToFront", {}, page.target.sessionId);
        // 写入已知初值后才读取本次复制结果，不读取原有剪贴板内容。
        await page.evaluate(
          'navigator.clipboard.writeText("未复制多目录路径")',
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await page.cdp.send(
            "Input.dispatchMouseEvent",
            { type, ...point, button: "right", clickCount: 1 },
            page.target.sessionId,
          );
        await clickExactText(page, '[role="menuitem"]', "复制相对路径");
        const readClipboard = async () => {
          const value = await page.evaluate<string>(
            "navigator.clipboard.readText()",
          );
          expect(value).not.toBe("未复制多目录路径");
          return value;
        };
        const copied = await vi.waitFor(readClipboard, { timeout: 5_000 });
        expect(copied).toBe(path);
        expect(await readScope(host)).toEqual(context.scopeBefore);
        expect(context.model.requests).toHaveLength(
          context.modelRequestCountBefore,
        );
      };
      await withTaskGroupPublicPage(verify, { seedTaskHistory: true });
    }, 180_000); // 原目录菜单、实际浏览器剪贴板及真实Task权限公开回归。
  },
);
