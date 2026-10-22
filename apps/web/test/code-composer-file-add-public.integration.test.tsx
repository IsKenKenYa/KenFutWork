// @vitest-environment node
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 ConversationComposer 文件添加公开接线 integration",
  () => {
    it("禁用输入框拒绝添加文件且恢复编辑后只追加一次", async () => {
      const fixtureLoading: Promise<{
        createCodeUiHttpFixture(): Promise<
          PublicFixture & { directory: string }
        >;
      }> = import(fixturePath);
      const http = await fixtureLoading;
      const fixture = await http.createCodeUiHttpFixture();
      let disposeClient: (() => void) | undefined;
      let releaseServices: (() => void) | undefined;
      try {
        const projectDirectory = join(fixture.directory, "disabled-composer");
        await mkdir(projectDirectory);
        const imagePath = join(projectDirectory, "app-icon.png");
        await copyFile(
          fileURLToPath(new URL("../public/app-icon.png", import.meta.url)),
          imagePath,
        );
        const stream = await fixture.client.openCodeStream();
        const opened = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: stream.ready.hello.connectionId,
          service: "workspace",
          method: "open",
          args: [{ path: projectDirectory }],
        });
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        releaseDom = await installCodePublicHostDom();
        const [
          channel,
          workspace,
          composer,
          draftControl,
          drafts,
          files,
          transports,
          Providers,
        ] = await Promise.all([
          import("../src/components/workbench/zcode/host/httpChannelClient"),
          import("../src/components/workbench/zcode/host/workspaceServices"),
          import("@zui/v4/ConversationComposer"),
          import("@zui/v4/composer/useDraftConfigControl"),
          import("@zui/v4/composer/composerDraftStore"),
          import("@zui/lib/workspaceFileDrag"),
          import("@zui/v4/agentConversationTransport"),
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
        const project = await client.openWorkspace(
          projectDirectory,
          opened.body.result.projectId,
        );
        releaseServices = workspace.bindCodeWorkspaceServices(client);
        const scope = {
          workspacePath: projectDirectory,
          workspaceIdentity: JSON.stringify([
            project.projectId,
            projectDirectory,
          ]),
        };
        const draftText = "保留这条未发送的草稿";
        drafts.persistV4ComposerDraft(
          projectDirectory,
          scope.workspaceIdentity,
          drafts.V4_DRAFT_SCOPE_ROOT,
          {
            text: draftText,
            mode: "build",
          },
        );
        const transport = transports.createAgentConversationTransport(
          client.services.zcodeAgentService,
          scope,
        );
        function FileComposer({ disabled }: { disabled: boolean }) {
          const owner = draftControl.useDraftConfigControl({
            ...scope,
            sessionId: null,
            modelSelectionService: client.services.modelSelectionService,
            agentStartupAllowed: false,
          });
          return (
            <composer.ConversationComposer
              {...scope}
              snapshot={null}
              draftMode
              disabled={disabled}
              autoFocusEnabled={false}
              composerDraft={owner.composerDraft}
              updateComposerContent={owner.updateComposerContent}
              replaceComposerDraft={owner.replaceComposerDraft}
              modelSelectionView={
                owner.modelSelectionRead.state.status === "ready"
                  ? owner.modelSelectionRead.state.view
                  : null
              }
              modelSelectionState={owner.modelSelectionRead.state}
              modelSelectionReload={owner.modelSelectionRead.reload}
              attachmentPut={transport.attachmentPut}
              attachmentBudget={transport.attachmentBudget}
              onSendText={async () => {
                throw new Error("禁用输入框不能发送消息");
              }}
              onStop={() => {
                throw new Error("本次添加文件不能停止运行");
              }}
              onSelectModel={owner.handleDraftSelectModel}
              onSelectThought={owner.handleDraftSelectThought}
              onSwitchMode={owner.handleDraftSwitchMode}
            />
          );
        }
        const originalComposer = (disabled: boolean) => (
          <Providers client={client}>
            <FileComposer disabled={disabled} />
          </Providers>
        );
        const view = render(originalComposer(true));
        const input = await view.findByRole("textbox");
        await waitFor(() => expect(input.textContent).toBe(draftText));
        expect(input.getAttribute("contenteditable")).toBe("false");

        const addImage = () =>
          files.dispatchWorkspaceFileAddToChat({
            type: "file",
            ...scope,
            path: imagePath,
            relativePath: "app-icon.png",
            name: "app-icon.png",
          });
        let accepted = false;
        act(() => {
          accepted = addImage();
        });

        expect(accepted).toBe(false);
        expect(input.textContent).toBe(draftText);

        view.rerender(originalComposer(false));
        act(() => {
          accepted = addImage();
        });
        expect(accepted).toBe(true);
        await waitFor(() =>
          expect(input.textContent).toContain("app-icon.png"),
        );
        expect(input.textContent).toContain(draftText);
        const afterFirstAdd = input.textContent;

        view.rerender(originalComposer(true));
        act(() => {
          accepted = addImage();
        });
        expect(accepted).toBe(false);
        expect(input.textContent).toBe(afterFirstAdd);

        view.rerender(originalComposer(false));
        act(() => {
          accepted = addImage();
        });
        expect(accepted).toBe(true);
        await waitFor(() =>
          expect(input.textContent?.match(/app-icon\.png/g)).toHaveLength(2),
        );
      } finally {
        cleanup();
        releaseServices?.();
        disposeClient?.();
        await fixture.close();
      }
    }, 90_000);
  },
);
