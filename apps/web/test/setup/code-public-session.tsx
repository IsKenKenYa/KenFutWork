import { randomUUID } from "node:crypto";
import { render } from "@testing-library/react";
import { expect } from "vitest";
import { z } from "zod";
import type { CodeUiTestClient } from "../../../server/src/features/code-ui/host-client.fixture.js";
import type { createCodeSessionFixture } from "../../../server/src/features/code-ui/host-session.fixture.js";
import type { CodeHttpChannelClient } from "../../src/components/workbench/zcode/host/httpChannelClient";
import { installCodePublicHostDom } from "./code-public-host-dom";
import { loadCodePublicHostProviders } from "./code-public-host-ui";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

/** 同项目下新建一个兄弟 Task：运行记录与检查点测试要验证「不串到别的 Task」。 */
export async function createPublicSiblingTask(host: Host) {
  const result = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: host.projectId },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return z.object({ sessionId: z.uuid() }).parse(result.body.result.result)
    .sessionId;
}
export type PublicFixture = {
  client: CodeUiTestClient;
  baseUrl: string;
  app: {
    kernel: { get(key: "localAccess"): { getDesktopToken(): Promise<string> } };
  };
  close(): Promise<void>;
};
export type OriginalSessionView = {
  client: CodeHttpChannelClient;
  view: ReturnType<typeof render>;
  dispose(): void;
  releaseDom(): void;
};
export async function renderOriginalSession(
  fixture: PublicFixture,
  host: Host,
  prepareBrowser?: () => void,
): Promise<OriginalSessionView> {
  const releaseDom = await installCodePublicHostDom();
  prepareBrowser?.();
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
      client,
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
