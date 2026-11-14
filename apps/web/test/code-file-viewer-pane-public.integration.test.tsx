// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCodePublicHostDom } from "./setup/code-public-host-dom";
import { loadCodePublicHostProviders } from "./setup/code-public-host-ui";
import type { PublicFixture } from "./setup/code-public-session";

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
type TaskFixture = {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  dispose(): Promise<void>;
};
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 PreviewPane 固定来源消费者 integration",
  () => {
    it("缺少文件来源只在原预览面板显示错误并保留兄弟内容", async () => {
      const fixtureLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture>;
      }> = import(fixturePath);
      const [http, sessions] = await Promise.all([
        fixtureLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let host: TaskFixture | undefined;
      let disposeClient: (() => void) | undefined;
      let releaseServices: (() => void) | undefined;
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
        });
        const workspacePath = host.workspacePath;
        const sourcePath = join(workspacePath, "legacy-source.svg");
        await writeFile(
          sourcePath,
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><title>真实来源文件</title></svg>',
        );
        releaseDom = await installCodePublicHostDom();
        const [channel, workspace, preview, boundary, Providers] =
          await Promise.all([
            import("../src/components/workbench/zcode/host/httpChannelClient"),
            import("../src/components/workbench/zcode/host/workspaceServices"),
            import("@zui/PreviewPane"),
            import("@zui/ErrorBoundary"),
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
        await client.openWorkspace(workspacePath, host.projectId);
        const taskId = host.sessionId;
        client.setViewerContextResolver(() => ({ kind: "task", taskId }));
        releaseServices = workspace.bindCodeWorkspaceServices(client);
        const legacySource: CodeViewerSource = {
          type: "file",
          title: "legacy-source.svg",
          path: sourcePath,
          workspacePath,
          workspaceIdentity: JSON.stringify([host.projectId, workspacePath]),
        };
        const fixedSource: CodeViewerSource = {
          ...legacySource,
          viewerScope: { kind: "task", taskId },
        };
        const renderPane = (source: CodeViewerSource) => (
          <Providers client={client}>
            <boundary.ScopedErrorBoundary scope="file-viewer-public-host">
              <input aria-label="已打开内容的草稿" defaultValue="原有内容" />
              <preview.PreviewPane
                source={source}
                workspacePath={workspacePath}
                onClose={() => {
                  throw new Error("来源读取失败不能关闭面板");
                }}
              />
            </boundary.ScopedErrorBoundary>
          </Providers>
        );
        const view = render(renderPane(fixedSource));
        await view.findByRole("img", { name: "legacy-source.svg" });
        const sibling = view.getByRole("textbox", { name: "已打开内容的草稿" });
        fireEvent.change(sibling, { target: { value: "保留已编辑的内容" } });

        view.rerender(renderPane(legacySource));

        await waitFor(() =>
          expect(view.getByTestId("preview-pane").textContent).toContain(
            "文件来源不可用，请重新打开文件",
          ),
        );
        expect(view.getByRole("textbox", { name: "已打开内容的草稿" })).toBe(
          sibling,
        );
        expect(sibling).toHaveProperty("value", "保留已编辑的内容");
      } finally {
        cleanup();
        releaseServices?.();
        disposeClient?.();
        try {
          await host?.dispose();
        } finally {
          await fixture.close();
        }
      }
    }, 120_000);
  },
);
