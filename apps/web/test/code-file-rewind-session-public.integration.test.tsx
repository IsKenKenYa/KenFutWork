// @vitest-environment node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type OriginalSessionView,
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const historyPath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/history-fork.fixture.ts",
    import.meta.url,
  ),
);
const gitPath = fileURLToPath(
  new URL("../../server/src/desktop/runtimes.ts", import.meta.url),
);
type History = {
  snapshot(
    fixture: PublicFixture,
    id: string,
  ): Promise<protocol.ConversationSnapshot>;
  waitPhase(
    fixture: PublicFixture,
    id: string,
    phase: string,
  ): Promise<protocol.ConversationSnapshot>;
};
let releaseDom: (() => void) | undefined;
function resetBrowser() {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
afterEach(resetBrowser);

// JSDOM不排版；只提供原虚拟列表所需的浏览器视口，不替换产品renderer。
function prepareTimelineViewport() {
  for (const [property, size] of [
    ["offsetWidth", 1200],
    ["clientWidth", 1200],
    ["offsetHeight", 900],
    ["clientHeight", 900],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-v4-timeline-scroll") ? size : 0;
      },
    );
  }
}

async function createFileTurn(operation: "edit" | "create" = "edit") {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(options: {
      gitBinDir: string;
    }): Promise<PublicFixture>;
  }> = import(fixturePath);
  const historyLoading: Promise<History> = import(historyPath);
  const gitLoading: Promise<{
    resolveSystemGitExecutable(options: {
      path: string;
      platform: NodeJS.Platform;
    }): string | null;
  }> = import(gitPath);
  const [http, sessions, streams, history, git] = await Promise.all([
    httpLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
    historyLoading,
    gitLoading,
  ]);
  const binary = git.resolveSystemGitExecutable({
    path: process.env.PATH ?? "",
    platform: process.platform,
  });
  if (!binary) throw new Error("文件撤销真实验收缺少宿主Git；未进入产品回归");
  const fixture = await http.createCodeUiHttpFixture({
    gitBinDir: dirname(binary),
  });
  const tools: NonNullable<
    Parameters<typeof streams.heldModel>[0]
  >["toolsByRequest"] = {
    1: {
      id: "rewind-edit",
      name: "Edit",
      arguments: {
        file_path: "rewind.txt",
        old_string: "before",
        new_string: "after",
      },
    },
  };
  const model = await streams.heldModel(
    operation === "edit"
      ? {
          initialTool: {
            id: "rewind-read",
            name: "Read",
            arguments: { file_path: "rewind.txt" },
          },
          toolsByRequest: tools,
        }
      : {
          initialTool: {
            id: "rewind-create",
            name: "Write",
            arguments: { file_path: "rewind.txt", content: "created\n" },
          },
        },
  );
  let host: Host | undefined;
  try {
    host = await sessions.createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig: { mode: "edit", planEnabled: false },
    });
    const path = join(host.workspacePath, "rewind.txt");
    if (operation === "edit") await writeFile(path, "before\n");
    else expect(await readdir(host.workspacePath)).toEqual([]);
    const text =
      operation === "edit"
        ? "EDIT_THEN_REWIND_ORIGINAL_UI"
        : "CREATE_THEN_REWIND_ORIGINAL_UI";
    await host.command("sendText", {
      text,
    });
    const requests = operation === "edit" ? 3 : 2;
    await vi.waitFor(() => expect(model.requests).toHaveLength(requests), {
      timeout: 30_000,
    });
    model.finish(requests - 1);
    const taskId = host.sessionId;
    let source = await history.waitPhase(fixture, taskId, "completedSuccess");
    // 终态与检查点可用性分别发表；等待公开投影就绪，不能把前置时序当撤销失败。
    await vi.waitFor(
      async () => {
        source = await history.snapshot(fixture, taskId);
        const ready = source.rows.window.find(
          (row) => row.kind === "turnHeader" && row.fileChanges?.files,
        );
        expect(
          ready?.kind === "turnHeader" && ready.actions?.canRewindFiles,
        ).toBe(true);
      },
      { timeout: 30_000 },
    );
    expect(await readFile(path, "utf8")).toBe(
      operation === "edit" ? "after\n" : "created\n",
    );
    const header = source.rows.window.find(
      (row) => row.kind === "turnHeader" && row.fileChanges?.files,
    );
    if (header?.kind !== "turnHeader" || !header.entityId)
      throw new Error("真实文件变更轮次缺失");
    expect(header.actions?.canRewindFiles).toBe(true);
    const completedHost = host;
    return {
      fixture,
      history,
      host,
      path,
      header,
      source,
      close: async () => {
        await completedHost.dispose();
        await model.close();
        await fixture.close();
      },
    };
  } catch (error) {
    if (host) await host.dispose();
    await model.close();
    await fixture.close();
    throw error;
  }
}

async function openUndo(session: OriginalSessionView) {
  const { view } = session;
  const undo = await view.findByRole(
    "button",
    { name: "撤销" },
    { timeout: 30_000 },
  );
  fireEvent.click(undo);
  const dialog = await view.findByRole(
    "dialog",
    { name: "撤销文件改动" },
    { timeout: 30_000 },
  );
  const confirm = within(dialog).getByRole("button", { name: "撤销文件" });
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false), {
    timeout: 30_000,
  });
  expect(dialog.textContent).toContain("rewind.txt");
  return { dialog, confirm };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原SessionPane文件撤销GUI公开接线 integration",
  () => {
    it("真实Edit后原预览安全，确认前外部改动不能被accepted吞掉，原弹窗保留拒绝原因与实盘字节", async () => {
      const turn = await createFileTurn();
      const { fixture, history, host, path, header, source } = turn;
      let session: OriginalSessionView | undefined;
      try {
        session = await renderOriginalSession(
          fixture,
          host,
          prepareTimelineViewport,
        );
        releaseDom = session.releaseDom;
        const { view } = session;
        const { dialog, confirm } = await openUndo(session);
        await writeFile(path, "EXTERNAL_NEW_BYTES\n");
        fireEvent.click(confirm);
        await waitFor(
          () => expect(dialog.textContent).toContain("文件不满足安全恢复条件"),
          { timeout: 30_000 },
        );
        expect(view.getByRole("dialog", { name: "撤销文件改动" })).toBe(dialog);
        expect(await readFile(path, "utf8")).toBe("EXTERNAL_NEW_BYTES\n");
        const current = await history.snapshot(fixture, host.sessionId);
        expect(current.revision).toBe(source.revision);
        expect(current.logEpoch).toBe(source.logEpoch);
        expect(
          current.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["EDIT_THEN_REWIND_ORIGINAL_UI"]);
        expect(
          current.rows.window.find((row) => row.rowId === header.rowId)?.kind,
        ).toBe("turnHeader");
        const unsafeCommand = crypto.randomUUID();
        const guard = {
          baseRevision: current.revision,
          baseLogEpoch: current.logEpoch,
        };
        const payload = {
          target: { rowId: header.rowId, entityId: header.entityId },
        };
        const first = await host.command(
          "applyFileRewind",
          payload,
          unsafeCommand,
          guard,
        );
        expect(first.body.result).toMatchObject({
          status: "rejected",
          result: { type: "applyFileRewind", applied: false },
        });
        const replay = await host.command(
          "applyFileRewind",
          payload,
          unsafeCommand,
          guard,
        );
        expect(replay.body.result).toMatchObject({
          status: "rejected",
          result: { type: "applyFileRewind", applied: false },
        });
        const queried = await host.stream.rpc("queryConversationCommandsV4", [
          {
            workspacePath: host.workspacePath,
            commands: [{ sessionId: host.sessionId, commandId: unsafeCommand }],
          },
        ]);
        expect(queried.body.result.results[0].result).toMatchObject({
          status: "rejected",
          result: { type: "applyFileRewind", applied: false },
        });
        expect(await readFile(path, "utf8")).toBe("EXTERNAL_NEW_BYTES\n");
      } finally {
        session?.dispose();
        await turn.close();
      }
    }, 120_000);
    it("原撤销恢复真实Edit字节并关闭弹窗，重新打开原SessionPane仍显示已撤销且保留聊天", async () => {
      const turn = await createFileTurn();
      const { fixture, history, host, path, header } = turn;
      let session: OriginalSessionView | undefined;
      try {
        session = await renderOriginalSession(
          fixture,
          host,
          prepareTimelineViewport,
        );
        releaseDom = session.releaseDom;
        const { confirm } = await openUndo(session);
        const { view } = session;
        fireEvent.click(confirm);
        await waitFor(
          () =>
            expect(
              view.queryByRole("dialog", { name: "撤销文件改动" }),
            ).toBeNull(),
          { timeout: 30_000 },
        );
        expect(await readFile(path, "utf8")).toBe("before\n");
        const current = await history.snapshot(fixture, host.sessionId);
        expect(
          current.rows.window.find((row) => row.rowId === header.rowId),
        ).toMatchObject({
          fileChanges: { files: 1, state: "reverted" },
        });
        expect(
          current.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["EDIT_THEN_REWIND_ORIGINAL_UI"]);
        session.dispose();
        resetBrowser();
        session = await renderOriginalSession(
          fixture,
          host,
          prepareTimelineViewport,
        );
        releaseDom = session.releaseDom;
        const undo = await session.view.findByRole(
          "button",
          { name: "撤销" },
          { timeout: 30_000 },
        );
        expect(undo.hasAttribute("disabled")).toBe(true);
        expect(session.view.getByText("已撤销").textContent).toBe("已撤销");
        expect(await readFile(path, "utf8")).toBe("before\n");
      } finally {
        session?.dispose();
        await turn.close();
      }
    }, 120_000);
    it("空目录首轮Write通过原撤销删除新文件，保留外部后来新建文件与聊天", async () => {
      const turn = await createFileTurn("create");
      const { fixture, history, host, path, header } = turn;
      let session: OriginalSessionView | undefined;
      try {
        session = await renderOriginalSession(
          fixture,
          host,
          prepareTimelineViewport,
        );
        releaseDom = session.releaseDom;
        const { confirm } = await openUndo(session);
        const external = join(host.workspacePath, "external.txt");
        await writeFile(external, "EXTERNAL_CREATED_AFTER_RUN\n");
        fireEvent.click(confirm);
        const { view } = session;
        await waitFor(
          () =>
            expect(
              view.queryByRole("dialog", { name: "撤销文件改动" }),
            ).toBeNull(),
          { timeout: 30_000 },
        );
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(external, "utf8")).toBe(
          "EXTERNAL_CREATED_AFTER_RUN\n",
        );
        const current = await history.snapshot(fixture, host.sessionId);
        expect(
          current.rows.window.find((row) => row.rowId === header.rowId),
        ).toMatchObject({
          fileChanges: { files: 1, state: "reverted" },
        });
        expect(
          current.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["CREATE_THEN_REWIND_ORIGINAL_UI"]);
      } finally {
        session?.dispose();
        await turn.close();
      }
    }, 120_000);
  },
);
