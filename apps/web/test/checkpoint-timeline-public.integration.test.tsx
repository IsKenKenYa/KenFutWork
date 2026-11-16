// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import {
  createPublicSiblingTask,
  type PublicFixture,
} from "./setup/code-public-session.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

type Actor = { instanceId: string; accessClientId: string | null };
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Fixture = PublicFixture & {
  actor: Actor;
  origin: string;
  cookie: string;
  app: {
    kernel: {
      get(key: "executionScopes"): {
        openTask(actor: Actor, taskId: string): Promise<unknown>;
      };
      get(key: "checkpoints"): {
        beforeTurn(input: {
          scope: unknown;
          actor: Actor;
          runId: string;
        }): Promise<{ id: string } | null>;
      };
    };
  };
};

function checkpointGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function bindCheckpointTransport(fixture: Fixture) {
  const nativeFetch = globalThis.fetch;
  const control = {
    failList: true,
    failPreview: true,
    holdPreview: false,
    receivedPreview: checkpointGate(),
    releasePreview: checkpointGate(),
    replies: [] as Array<[string, number]>,
    loadedTaskIds: new Set<string | null>(),
  };
  // 只改变本独占页面的请求凭据或交付时机；响应体由真实 Fastify 生成。
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const target = new URL(url);
    const route = target.pathname;
    const isPreview = route.endsWith("/preview");
    const headers = new Headers(init?.headers);
    headers.set("origin", fixture.origin);
    if (
      !(route.endsWith("/checkpoints") && control.failList) &&
      !(isPreview && control.failPreview)
    )
      headers.set("cookie", fixture.cookie);
    const response = await nativeFetch(url, { ...init, headers });
    control.replies.push([route, response.status]);
    if (route.endsWith("/checkpoints") && response.ok)
      control.loadedTaskIds.add(target.searchParams.get("taskId"));
    if (isPreview && control.holdPreview) {
      control.receivedPreview.resolve();
      await control.releasePreview.promise;
    }
    return response;
  });
  return control;
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "没有用户 Git 仓库也能从状态面板打开真实检查点并安全回滚",
  async () => {
    const fixtureLoading: Promise<{
      createCodeUiHttpFixture(): Promise<Fixture>;
    }> = import(fixturePath);
    const [http, sessions, models] = await Promise.all([
      fixtureLoading,
      import("../../server/src/features/code-ui/host-session.fixture.js"),
      import("../../server/src/features/code-ui/model-stream.fixture.js"),
    ]);
    const fixture = await http.createCodeUiHttpFixture();
    let model: Awaited<ReturnType<typeof models.heldModel>> | undefined;
    let host: Host | undefined;
    let releaseDom: (() => void) | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      model = await models.heldModel();
      host = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      const workspacePath = host.workspacePath;
      const taskId = host.sessionId;
      await expect(stat(join(workspacePath, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const gitSummary = await host.client.request("/api/code-ui/rpc", {
        service: "git",
        method: "getRepositorySummary",
        args: [{ workspacePath, viewerScope: { kind: "task", taskId } }],
      });
      expect(gitSummary.status).toBe(200);
      expect(gitSummary.body.result.isRepository).toBe(false);
      const path = join(workspacePath, "checkpoint.txt");
      const actor = fixture.actor;
      const scope = await fixture.app.kernel
        .get("executionScopes")
        .openTask(actor, taskId);
      await writeFile(path, "检查点原内容\n");
      const checkpoint = await fixture.app.kernel
        .get("checkpoints")
        .beforeTurn({ scope, actor, runId: randomUUID() });
      if (!checkpoint) throw new Error("未创建真实 Git 检查点");
      await writeFile(path, "等待恢复的内容\n");

      releaseDom = await installCodePublicHostDom();
      const [
        { ConversationStatusPanel },
        { ZCodeIntlProvider },
        { TooltipProvider },
        { setSurfaceApiBase },
        { useZCodeSessionStore },
      ] = await Promise.all([
        import("@zui/v4/ConversationStatusPanel.js"),
        import("@zui/i18n/IntlProvider.js"),
        import("@zui/components/ui/tooltip.js"),
        import("../src/components/workbench/zcode/host/surfaceApi.js"),
        import("@zui/store/zcodeSessionStore.js"),
      ]);
      setSurfaceApiBase(fixture.baseUrl);
      useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
      const transport = bindCheckpointTransport(fixture);

      const panel = render(
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <ConversationStatusPanel
              workspacePath={workspacePath}
              hasActiveTask
              summaryPanelVariantOverride="panel"
            />
          </TooltipProvider>
        </ZCodeIntlProvider>,
      );
      view = panel;
      expect(panel.getByRole("button", { name: "运行记录" })).toBeTruthy();
      expect(panel.queryByText("Git 工具")).toBeNull();
      const listError = await panel.findByRole("alert");
      expect(listError.textContent).toContain("本机连接已失效");
      expect(transport.replies).toContainEqual(["/api/code/checkpoints", 401]);
      transport.failList = false;
      fireEvent.click(panel.getByRole("button", { name: "重试读取检查点" }));
      fireEvent.click(await panel.findByRole("button", { name: "检查点" }));
      const dialog = within(
        await panel.findByRole("dialog", { name: "回滚到检查点" }),
      );
      expect((await dialog.findByRole("alert")).textContent).toContain(
        "本机连接已失效",
      );
      const restore = dialog.getByRole("button", { name: "回滚" });
      expect(restore.hasAttribute("disabled")).toBe(true);
      expect(dialog.queryByText("读取预览…")).toBeNull();
      transport.failPreview = false;
      fireEvent.click(dialog.getByRole("button", { name: "重新预览" }));
      const diff = await dialog.findByText(/checkpoint\.txt/);
      expect(diff.textContent).toContain("+1 −1");

      await writeFile(path, "预览之后的外部改动\n");
      fireEvent.click(restore);
      await dialog.findByRole("alert");
      const restorePath = `/api/code/checkpoints/${checkpoint.id}/restore`;
      expect(transport.replies).toContainEqual([restorePath, 409]);
      expect(restore.hasAttribute("disabled")).toBe(true);
      expect(await readFile(path, "utf8")).toBe("预览之后的外部改动\n");
      fireEvent.click(dialog.getByRole("button", { name: "重新预览" }));
      await waitFor(() => expect(restore.hasAttribute("disabled")).toBe(false));
      fireEvent.click(restore);
      const dialogQuery = () =>
        panel.queryByRole("dialog", { name: "回滚到检查点" });
      await waitFor(() => expect(dialogQuery()).toBeNull());
      expect(transport.replies).toContainEqual([restorePath, 200]);
      expect(await readFile(path, "utf8")).toBe("检查点原内容\n");

      const siblingTaskId = await createPublicSiblingTask(host);
      transport.holdPreview = true;
      fireEvent.click(await panel.findByRole("button", { name: "检查点" }));
      await transport.receivedPreview.promise;
      await act(async () => {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(workspacePath, siblingTaskId);
      });
      await waitFor(() =>
        expect(transport.loadedTaskIds.has(siblingTaskId)).toBe(true),
      );
      await act(async () => transport.releasePreview.resolve());
      expect(panel.queryByRole("button", { name: "检查点" })).toBeNull();
      expect(dialogQuery()).toBeNull();
      await act(async () => {
        useZCodeSessionStore.getState().setActiveTaskId(workspacePath, taskId);
      });
      await panel.findByRole("button", { name: "检查点" });
      expect(dialogQuery()).toBeNull();
      await expect(stat(join(workspacePath, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      view?.unmount();
      // 等待 Radix 的卸载焦点事件在当前 DOM 中发出。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseDom?.();
      vi.unstubAllGlobals();
      await host?.dispose();
      await model?.close();
      await fixture.close();
    }
  },
  120_000,
);
