// @vitest-environment node
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codeUiViewerScopeSchema } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { pressKey } from "../../server/src/features/browser/cdp-client.js";
import {
  activateCommandButton,
  commandSearchInput,
  enterCommandQuery,
  openCommandCenter,
} from "./setup/code-command-center-public.js";
import {
  observeViewerRequests,
  viewerRpcSchema,
} from "./setup/code-file-viewer-public.fixture.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { withTaskGroupPublicPage } from "./setup/code-task-groups-public.fixture.js";

const query = "@command-file-proof";
const oldFile = "command-file-proof-older.txt";
const newFile = "command-file-proof-current.txt";
const newContent = "重新搜索后读取到的真实内容";
const preview = '[data-testid="preview-pane"]';
const indexLength = "listWorkspaceFilesLength";
const indexRange = "listWorkspaceFilesRange";
const filepath = z.object({
  rootPath: z.string(),
  viewerScope: codeUiViewerScopeSchema,
});

function readSearch(page: OriginalSessionBrowser) {
  return page.evaluate<{
    alert: string | null;
    names: string[];
    noResults: boolean;
    inputFocused: boolean;
    query: string;
  }>(`(() => {
    const field = document.querySelector(${JSON.stringify(commandSearchInput)});
    const dialog = field.closest('[role="dialog"]');
    return {
      alert: dialog.querySelector('[role="alert"]')?.textContent.trim() ?? null,
      names: [...dialog.querySelectorAll('[role="option"]')].map(option => option.textContent.trim()),
      noResults: dialog.textContent.includes('暂无相关结果'),
      inputFocused: document.activeElement === field,
      query: field.value,
    };
  })()`);
}

async function expectNames(page: OriginalSessionBrowser, ...names: string[]) {
  await vi.waitFor(async () =>
    expect((await readSearch(page)).names).toEqual(names),
  );
}

async function interruptOneIndexChunk(
  page: OriginalSessionBrowser,
  root: string,
) {
  const { cdp, target } = page;
  let interrupted = false;
  const commands: Promise<unknown>[] = [];
  const off = cdp.on("Fetch.requestPaused", (event, id) => {
    if (id !== target.sessionId || typeof event.requestId !== "string") return;
    const { postData } = z
      .object({ postData: z.string().optional() })
      .parse(event.request);
    const rpc = postData
      ? viewerRpcSchema.safeParse(JSON.parse(postData))
      : null;
    const interrupt =
      !interrupted &&
      rpc?.success &&
      rpc.data.service === "file" &&
      rpc.data.method === indexRange &&
      filepath.parse(rpc.data.args[0]).rootPath === root;
    if (interrupt) interrupted = true;
    const command = cdp.send(
      interrupt ? "Fetch.failRequest" : "Fetch.continueRequest",
      {
        requestId: event.requestId,
        ...(interrupt ? { errorReason: "ConnectionReset" } : {}),
      },
      target.sessionId,
    );
    commands.push(command);
    void command.catch(() => undefined);
  });
  await cdp.send(
    "Fetch.enable",
    { patterns: [{ urlPattern: "*/api/code-ui/rpc" }] },
    target.sessionId,
  );
  return {
    get interrupted() {
      return interrupted;
    },
    async close() {
      try {
        await cdp.send("Fetch.disable", {}, target.sessionId);
        await Promise.all(commands);
      } finally {
        off();
      }
    },
  };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原命令中心文件搜索",
  () => {
    it("重开读取新增和删除后的文件，并以原 Task 打开真实内容", async () => {
      await withTaskGroupPublicPage(
        async ({ host, page, model }) => {
          const root = host.workspacePath;
          const observation = observeViewerRequests(page);
          try {
            await writeFile(join(root, oldFile), "原搜索结果", "utf8");
            await openCommandCenter(page);
            await enterCommandQuery(page, query);
            await expectNames(page, oldFile);
            await pressKey(page.cdp, page.target.sessionId, "Escape");
            await vi.waitFor(async () =>
              expect(
                await page.evaluate(
                  `document.querySelector(${JSON.stringify(commandSearchInput)}) === null`,
                ),
              ).toBe(true),
            );
            await unlink(join(root, oldFile));
            await writeFile(join(root, newFile), newContent, "utf8");
            await openCommandCenter(page);
            await enterCommandQuery(page, query);
            await expectNames(page, newFile);
            await enterCommandQuery(page, "@command-file-proof-unmatched");
            await vi.waitFor(async () =>
              expect(await readSearch(page)).toMatchObject({
                names: [],
                noResults: true,
              }),
            );
            await enterCommandQuery(page, "@command-file-proof-current");
            await expectNames(page, newFile);
            const scans = [...observation.requests.values()].filter(
              ({ service, method }) =>
                service === "file" && method === indexLength,
            );
            expect(
              scans.map(({ args, status }) => ({
                ...filepath.parse(args[0]),
                status,
              })),
            ).toEqual(
              Array.from({ length: 2 }, () => ({
                rootPath: root,
                viewerScope: { kind: "task", taskId: host.sessionId },
                status: 200,
              })),
            );
            await pressKey(page.cdp, page.target.sessionId, "ArrowDown");
            await pressKey(page.cdp, page.target.sessionId, "Enter");
            await vi.waitFor(async () =>
              expect(
                await page.evaluate<string | null>(
                  `document.querySelector(${JSON.stringify(`${preview} diffs-container`)})?.shadowRoot?.textContent ?? null`,
                ),
                JSON.stringify(page.pageErrors),
              ).toContain(newContent),
            );
            expect(
              [...observation.requests.values()]
                .filter(({ method }) => method === "readTextFile")
                .map(({ args, status }) => ({
                  ...z
                    .object({
                      path: z.string(),
                      viewerScope: codeUiViewerScopeSchema,
                    })
                    .parse(args[0]),
                  status,
                })),
            ).toContainEqual({
              path: join(root, newFile),
              viewerScope: { kind: "task", taskId: host.sessionId },
              status: 200,
            });
            expect(model.requests).toHaveLength(1);
          } finally {
            observation.dispose();
          }
        },
        { seedTaskHistory: true, prepareTaskContent: false },
      );
    }, 120_000);

    it("文件索引分块中断时原位报错，重试保留查询与键盘焦点", async () => {
      await withTaskGroupPublicPage(
        async ({ host, page }) => {
          await writeFile(
            join(host.workspacePath, newFile),
            newContent,
            "utf8",
          );
          await openCommandCenter(page);
          const transport = await interruptOneIndexChunk(
            page,
            host.workspacePath,
          );
          try {
            await enterCommandQuery(page, query);
            await vi.waitFor(() => expect(transport.interrupted).toBe(true));
            await vi.waitFor(async () =>
              expect(await readSearch(page)).toMatchObject({
                alert: "文件读取失败",
                names: [],
                noResults: false,
              }),
            );
            await activateCommandButton(page, "重新读取文件");
            await vi.waitFor(async () =>
              expect(await readSearch(page)).toMatchObject({
                alert: null,
                names: [newFile],
                inputFocused: true,
                query,
              }),
            );
          } finally {
            await transport.close();
          }
        },
        { prepareTaskContent: false },
      );
    }, 120_000);
  },
);
