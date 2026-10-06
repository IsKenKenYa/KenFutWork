import { render } from "@testing-library/react";
import type { CodeUiTestClient } from "../../../server/src/features/code-ui/host-client.fixture.js";
import type { createCodeSessionFixture } from "../../../server/src/features/code-ui/host-session.fixture.js";
import { installCodePublicHostDom } from "./code-public-host-dom";
import { loadCodePublicHostProviders } from "./code-public-host-ui";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
export type PublicFixture = {
  client: CodeUiTestClient;
  baseUrl: string;
  app: {
    kernel: { get(key: "localAccess"): { getDesktopToken(): Promise<string> } };
  };
  close(): Promise<void>;
};
export type OriginalSessionView = {
  view: ReturnType<typeof render>;
  dispose(): void;
  releaseDom(): void;
};
export async function renderOriginalSession(
  fixture: PublicFixture,
  host: Host,
): Promise<OriginalSessionView> {
  const releaseDom = await installCodePublicHostDom();
  localStorage.setItem("zcode-v4-client-id:v1", host.clientId);
  const [pane, conversation, channel, workspace, Providers] = await Promise.all(
    [
      import("@zui/v4/SessionPane"),
      import("@zui/v4/V4ConversationContext"),
      import("../../src/components/workbench/zcode/host/httpChannelClient"),
      import("../../src/components/workbench/zcode/host/workspaceServices"),
      loadCodePublicHostProviders(),
    ],
  );
  const client = new channel.CodeHttpChannelClient({
    apiBase: fixture.baseUrl,
    accessToken: await fixture.app.kernel.get("localAccess").getDesktopToken(),
  });
  let releaseServices: (() => void) | undefined;
  try {
    await client.connect();
    await client.openWorkspace(host.workspacePath, host.projectId);
    client.setViewerContextResolver(() => ({
      kind: "task",
      taskId: host.sessionId,
    }));
    releaseServices = workspace.bindCodeWorkspaceServices(client);
    const scope = {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    };
    const view = render(
      <Providers client={client}>
        <conversation.V4PaneConversationProvider scope={scope}>
          <pane.SessionPane
            paneId="actual-queue-pane"
            sessionId={host.sessionId}
            rootSessionId={host.sessionId}
            {...scope}
          />
        </conversation.V4PaneConversationProvider>
      </Providers>,
    );
    let disposed = false;
    return {
      view,
      releaseDom,
      dispose() {
        if (disposed) return;
        disposed = true;
        view.unmount();
        releaseServices?.();
        client.dispose();
      },
    };
  } catch (error) {
    releaseServices?.();
    client.dispose();
    releaseDom();
    throw error;
  }
}
