// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeProjectEditorProjectSchema } from "@kenfutwork/shared";
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
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const pathSelector = 'input[placeholder="输入路径"]';
const selectSelector = '[data-testid="directory-browser-confirm"]';

function observeDirectoryRead(page: OriginalSessionBrowser, path: string) {
  const reads = new Map<
    string,
    { humanPurpose: unknown; status?: number; finished: boolean }
  >();
  const failures: unknown[] = [];
  const releaseRequest = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (sessionId !== page.target.sessionId) return;
      const request = params.request;
      if (
        typeof params.requestId !== "string" ||
        !request ||
        typeof request !== "object" ||
        !("postData" in request) ||
        typeof request.postData !== "string"
      )
        return;
      try {
        const body = JSON.parse(request.postData);
        if (
          body.service === "file" &&
          body.method === "readdir" &&
          body.args?.[0]?.path === path
        )
          reads.set(params.requestId, {
            humanPurpose: body.args[0].humanPurpose,
            finished: false,
          });
      } catch (error) {
        failures.push(error);
      }
    },
  );
  const releaseResponse = page.cdp.on(
    "Network.responseReceived",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const read = reads.get(params.requestId);
      const response = params.response;
      if (
        read &&
        response &&
        typeof response === "object" &&
        "status" in response &&
        typeof response.status === "number"
      )
        read.status = response.status;
    },
  );
  const releaseFinished = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      ) {
        const read = reads.get(params.requestId);
        if (read) read.finished = true;
      }
    },
  );
  return {
    reads: () => [...reads.values()],
    failures,
    dispose() {
      releaseRequest();
      releaseResponse();
      releaseFinished();
    },
  };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原全局目录选择器的真实重试 integration",
  () => {
    it.each([
      ["普通目录", ""],
      ["末尾空格", " "],
    ])(
      "%s：绑定失败后保留选择器并在目录重建后由原按钮打开项目",
      async (_name, suffix) => {
        const httpLoading: Promise<{
          createCodeUiHttpFixture(): Promise<
            PublicFixture & { origin: string }
          >;
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
        let observation: ReturnType<typeof observeDirectoryRead> | undefined;
        let directory: string | undefined;
        let openedProjectId: string | undefined;
        let neighborProjectId: string | undefined;
        const failures: unknown[] = [];
        try {
          directory = await realpath(
            await mkdtemp(join(tmpdir(), "code-directory-retry-")),
          );
          const plainDirectory = join(directory, "重试打开的项目目录");
          const targetDirectory = `${plainDirectory}${suffix}`;
          if (suffix) await mkdir(plainDirectory);
          await mkdir(targetDirectory);
          model = await models.heldModel();
          host = await sessions.createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const session = host;
          if (suffix) {
            const neighbor = await session.client.request("/api/projects", {
              name: "相邻目录项目",
              kind: "code",
              work_dir: plainDirectory,
              directory_choice: "independent",
            });
            expect(neighbor.status, JSON.stringify(neighbor.body)).toBe(201);
            neighborProjectId = neighbor.body.project.id;
          }
          const readProjects = async () => {
            const response = await session.client.request("/api/code-ui/rpc", {
              service: "project",
              method: "readProjects",
              args: [{ hostId: "local" }],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return codeProjectEditorProjectSchema
              .array()
              .parse(response.body.result);
          };
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
          observation = observeDirectoryRead(page, targetDirectory);
          const reads = observation;
          await clickExactText(
            page,
            '[data-testid="sidebar"] [role="tab"]',
            "项目",
          );
          await clickOn(page.cdp, page.target.sessionId, {
            selector: '[data-testid="project-add"]',
          });
          await clickExactText(page, '[role="menuitem"]', "打开文件夹");
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
              const input = document.querySelector(${JSON.stringify(pathSelector)});
              const select = document.querySelector(${JSON.stringify(selectSelector)});
              return Boolean(input && select && !select.disabled);
            })()`),
              JSON.stringify(page.pageErrors),
            ).toBe(true),
          );
          await clickOn(page.cdp, page.target.sessionId, {
            selector: pathSelector,
          });
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, targetDirectory);
          await clickExactText(page, "button", "前往");
          await vi.waitFor(() => {
            expect(reads.failures).toEqual([]);
            expect(reads.reads()).toEqual([
              { humanPurpose: "directory-picker", status: 200, finished: true },
            ]);
          });
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
              const input = document.querySelector(${JSON.stringify(pathSelector)});
              const select = document.querySelector(${JSON.stringify(selectSelector)});
              return {
                path: input?.value,
                ready: Boolean(select && !select.disabled),
                empty: document.body.innerText.includes("无子目录"),
              };
            })()`),
              JSON.stringify(page.pageErrors),
            ).toEqual({ path: targetDirectory, ready: true, empty: true }),
          );
          await page.evaluate(`(() => {
          window.__directoryRetryPublicState = {
            input: document.querySelector(${JSON.stringify(pathSelector)}),
            select: document.querySelector(${JSON.stringify(selectSelector)}),
          };
        })()`);
          if (suffix) {
            const candidates = await session.client.request(
              `/api/projects/directory-candidates?path=${encodeURIComponent(targetDirectory)}`,
            );
            expect(candidates.status, JSON.stringify(candidates.body)).toBe(
              200,
            );
            expect(candidates.body.projects).toEqual([]);
          }
          await rmdir(targetDirectory);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: selectSelector,
          });
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
              const original = window.__directoryRetryPublicState;
              const input = document.querySelector(${JSON.stringify(pathSelector)});
              const select = document.querySelector(${JSON.stringify(selectSelector)});
              return {
                sameInput: Boolean(input && input === original.input),
                sameSelect: Boolean(select && select === original.select),
                path: input?.value,
                canRetry: Boolean(select && !select.disabled),
                error: document.body.innerText.includes("无法读取目录："),
              };
            })()`),
              JSON.stringify(page.pageErrors),
            ).toEqual({
              sameInput: true,
              sameSelect: true,
              path: targetDirectory,
              canRetry: true,
              error: true,
            }),
          );
          expect(
            (await readProjects()).filter((project) =>
              project.roots.some((root) => root.rootPath === targetDirectory),
            ),
          ).toEqual([]);
          await mkdir(targetDirectory);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: selectSelector,
          });
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(selectSelector)}) === null`,
              ),
              JSON.stringify(page.pageErrors),
            ).toBe(true),
          );
          const opened = (await readProjects()).filter((project) =>
            project.roots.some(
              (root) => root.isPrimary && root.rootPath === targetDirectory,
            ),
          );
          expect(opened).toHaveLength(1);
          const project = opened[0];
          if (!project) throw new Error("原目录重试未创建真实项目。");
          openedProjectId = project.id;
          expect(project.id).not.toBe(session.projectId);
          const projectSelector = `[data-project-id=${JSON.stringify(project.id)}]`;
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(`(() => {
              const input = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'))
                .find(element => !element.closest('[aria-hidden="true"]') && element.checkVisibility());
              return {
                projects: document.querySelectorAll(${JSON.stringify(projectSelector)}).length,
                composerReady: Boolean(input && input.checkVisibility()),
                originalTaskActive: input?.closest('[data-session-id]')?.getAttribute('data-session-id') === ${JSON.stringify(session.sessionId)},
              };
            })()`),
              JSON.stringify(page.pageErrors),
            ).toEqual({
              projects: 1,
              composerReady: true,
              originalTaskActive: false,
            }),
          );
          expect(model.requests).toEqual([]);
        } catch (error) {
          failures.push(error);
        } finally {
          for (const close of [
            () => observation?.dispose(),
            () => browser?.close(),
            async () => {
              if (!neighborProjectId || !host) return;
              const response = await host.client.request(
                `/api/projects/${neighborProjectId}`,
                undefined,
                "DELETE",
              );
              expect(response.status, JSON.stringify(response.body)).toBe(204);
            },
            async () => {
              if (!openedProjectId || !host) return;
              const response = await host.client.request(
                `/api/projects/${openedProjectId}`,
                undefined,
                "DELETE",
              );
              expect(response.status, JSON.stringify(response.body)).toBe(204);
            },
            () => host?.dispose(),
            () => fixture.close(),
            () => model?.close(),
            () => directory && rm(directory, { recursive: true, force: true }),
          ]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length)
          throw new AggregateError(failures, "原目录重试验证或清理失败", {
            cause: failures[0],
          });
      },
      180_000,
    );
  },
);
