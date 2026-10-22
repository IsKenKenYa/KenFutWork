// @vitest-environment node
import { channel } from "node:diagnostics_channel";
import { fileURLToPath } from "node:url";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seedTextDraft(host: Host) {
  const identity = JSON.stringify([host.projectId, host.workspacePath]);
  localStorage.setItem(
    `zcode-v4-composer-drafts:v1:${encodeURIComponent(identity)}`,
    JSON.stringify({
      version: 1,
      scopes: {
        [host.sessionId]: {
          text: "PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER",
          updatedAt: Date.now(),
        },
      },
    }),
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原SessionPane独立规划与基础权限 integration",
  () => {
    it("Plan开关折返保留基础权限和输入草稿，不请求执行方式服务或创建Goal", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture>;
      }> = import(fixturePath);
      const [http, sessions, surface] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../src/components/workbench/zcode/host/surfaceApi.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let host: Host | undefined;
      let session: OriginalSessionView | undefined;
      const strategyRequests: string[] = [];
      const requests = channel("undici:request:create");
      const observeRequest = (message: unknown) => {
        const { request } = message as {
          request: { origin: string; path: string };
        };
        if (
          request.origin === fixture.baseUrl &&
          request.path.startsWith("/api/execution-modes")
        )
          strategyRequests.push(request.path);
      };
      requests.subscribe(observeRequest);
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const currentHost = host;
        surface.setSurfaceApiBase(fixture.baseUrl);
        session = await renderOriginalSession(fixture, host, () =>
          seedTextDraft(currentHost),
        );
        releaseDom = session.releaseDom;
        await waitFor(
          () => {
            expect(
              session!.view.getByTestId("chat-mode-select-trigger").textContent,
            ).toContain("完全访问");
            expect(
              session!.view.getByTestId("v4-composer-input").textContent,
            ).toContain("PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER");
            expect(
              session!.view
                .getByTestId("v4-composer-send")
                .hasAttribute("disabled"),
            ).toBe(false);
          },
          { timeout: 30_000 },
        );
        const user = userEvent.setup({ document });
        for (let attempt = 0; attempt < 2; attempt++) {
          await user.click(
            session.view.getByTestId("chat-mode-select-trigger"),
          );
          expect(
            session.view.queryByRole("group", { name: "执行方式" }),
          ).toBeNull();
          expect(session.view.getAllByRole("menuitemradio")).toHaveLength(3);
          await user.click(
            await session.view.findByRole("menuitemcheckbox", {
              name: /^计划模式/,
            }),
          );
          await waitFor(() =>
            expect(
              session!.view.getByTestId("v4-composer-plan-marker"),
            ).toBeTruthy(),
          );
          await user.click(
            session.view.getByRole("button", { name: /^关闭计划模式$/ }),
          );
          await waitFor(() =>
            expect(
              session!.view.queryByTestId("v4-composer-plan-marker"),
            ).toBeNull(),
          );
          expect(
            session.view.getByTestId("chat-mode-select-trigger").textContent,
          ).toContain("完全访问");
        }
        const snapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(snapshot.config).toMatchObject({
          mode: "yolo",
          planEnabled: false,
        });
        expect(snapshot.goal).toBeNull();
        expect(
          session.view.getByTestId("v4-composer-input").textContent,
        ).toContain("PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER");
        expect(strategyRequests).toEqual([]);
      } finally {
        requests.unsubscribe(observeRequest);
        session?.dispose();
        surface.setSurfaceApiBase("");
        if (host) await host.dispose();
        await fixture.close();
      }
    }, 120_000);
  },
);
