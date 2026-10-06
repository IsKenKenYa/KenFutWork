// @vitest-environment node
import { fileURLToPath } from "node:url";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeUiTestClient } from "../../server/src/features/code-ui/host-client.fixture.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom";
import { loadCodePublicHostProviders } from "./setup/code-public-host-ui";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type PublicFixture = {
  client: CodeUiTestClient;
  baseUrl: string;
  app: {
    kernel: { get(key: "localAccess"): { getDesktopToken(): Promise<string> } };
  };
  close(): Promise<void>;
};
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
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原后台Bash详情GUI公开接线 integration",
  () => {
    it("原组件沿真实Channel查询日志，隐藏后重开读取终态，全文按钮读取所属Task完整文件", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture>;
      }> = import(fixturePath);
      const historyLoading: Promise<History> = import(historyPath);
      const [http, sessions, streams, history] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
        historyLoading,
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof streams.heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await streams.heldModel({
        initialTool: {
          id: "original-ui-log",
          name: "Bash",
          arguments: {
            command:
              "printf 'ORIGINAL_GUI_BOOT\n'; IFS= read -r line; printf 'GUI_DONE:%s\n' \"$line\"",
            run_in_background: true,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      let releaseServices: (() => void) | undefined;
      let disposeClient: (() => void) | undefined;
      try {
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        await host.command("sendText", { text: "ORIGINAL_GUI_BACKGROUND_LOG" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const state = await history.snapshot(fixture, host.sessionId);
        const work = state.backgroundWorks.find(
          (entry) => entry.kind === "bash" && entry.status === "running",
        );
        if (!work) throw new Error("原组件验收缺少真实后台工作");
        releaseDom = await installCodePublicHostDom();
        const [pane, channel, workspace, preview, Providers] =
          await Promise.all([
            import("@zui/app-shell/BackgroundBashOutputSidePane"),
            import("../src/components/workbench/zcode/host/httpChannelClient"),
            import("../src/components/workbench/zcode/host/workspaceServices"),
            import("@zui/PreviewPane"),
            loadCodePublicHostProviders(),
          ]);
        const client = new channel.CodeHttpChannelClient({
          apiBase: fixture.baseUrl,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
        });
        disposeClient = () => client.dispose();
        await client.connect();
        await client.openWorkspace(host.workspacePath, host.projectId);
        client.setViewerContextResolver(() => ({
          kind: "task",
          taskId: state.sessionId,
        }));
        releaseServices = workspace.bindCodeWorkspaceServices(client);
        const identity = JSON.stringify([host.projectId, host.workspacePath]);
        const tab = {
          id: "actual-background-tab",
          type: "bash-output" as const,
          workspacePath: host.workspacePath,
          workspaceIdentity: identity,
          workspaceKey: identity,
          ownerTaskId: host.sessionId,
          rootSessionId: host.sessionId,
          sessionId: host.sessionId,
          workId: work.workId,
          title: "真实后台日志",
        };
        const opened: CodeViewerSource[] = [];
        let fullFile: Promise<{ content: string }> | undefined;
        const open = (source: CodeViewerSource) => {
          opened.push(source);
          if (source.type !== "file")
            throw new Error("原全文按钮没有打开文件源");
          fullFile = client.services.fileService.readTextFile({
            path: source.path,
          });
        };
        const originalPane = (
          visible: boolean,
          source: CodeViewerSource | null = null,
        ) => (
          <Providers client={client}>
            <pane.BackgroundBashOutputSidePane
              tab={tab}
              visible={visible}
              onOpenCodeViewer={open}
            />
            {source ? (
              <preview.PreviewPane source={source} onClose={() => {}} />
            ) : null}
          </Providers>
        );
        const view = render(originalPane(true));
        await waitFor(
          () =>
            expect(
              view.getByTestId("background-bash-output").textContent,
            ).toContain("ORIGINAL_GUI_BOOT"),
          { timeout: 30_000 },
        );
        expect(view.getAllByTestId("background-bash-running")).toHaveLength(1);
        view.rerender(originalPane(false));
        tools[2] = {
          id: "release-original-ui-log",
          name: "TaskInput",
          arguments: { task_id: work.workId, data: "中文🙂\n", close: true },
        };
        model.finish(1);
        await history.waitPhase(fixture, host.sessionId, "completedSuccess");
        await host.command("sendText", { text: "FINISH_ORIGINAL_GUI_LOG" });
        await vi.waitFor(
          () => expect(model.requests.length).toBeGreaterThanOrEqual(4),
          { timeout: 30_000 },
        );
        view.rerender(originalPane(true));
        await waitFor(
          () => {
            expect(
              view
                .getByTestId("background-bash-details")
                .getAttribute("data-status"),
            ).toBe("completed");
            expect(view.getByTestId("background-bash-output").textContent).toBe(
              "ORIGINAL_GUI_BOOT\nGUI_DONE:中文🙂\n",
            );
          },
          { timeout: 30_000 },
        );
        expect(view.queryByTestId("background-bash-running")).toBeNull();
        fireEvent.click(view.getByTestId("background-bash-file"));
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({
          type: "file",
          workspacePath: host.workspacePath,
          workspaceIdentity: identity,
          path: expect.stringContaining(`code-output:${host.sessionId}/`),
        });
        if (!fullFile) throw new Error("原文件服务未收到全文读取");
        expect((await fullFile).content).toBe(
          "ORIGINAL_GUI_BOOT\nGUI_DONE:中文🙂\n",
        );
        const source = opened[0];
        if (!source) throw new Error("原文件查看器缺少全文按钮的真实来源");
        view.rerender(originalPane(true, source));
        await waitFor(
          () => {
            const viewer = view.getByTestId("preview-pane");
            const content =
              viewer.querySelector("diffs-container")?.shadowRoot?.textContent;
            expect(content).toContain("ORIGINAL_GUI_BOOT");
            expect(content).toContain("GUI_DONE:中文🙂");
          },
          { timeout: 30_000 },
        );
        view.unmount();
      } finally {
        cleanup();
        releaseServices?.();
        disposeClient?.();
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
