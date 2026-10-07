// @vitest-environment node
import { fileURLToPath } from "node:url";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
  "原SessionPane审批GUI公开接线 integration",
  () => {
    it("原审批卡显示实际待批准命令，等待超过模型阈值仍在，原允许按钮恢复真实工具与模型", async () => {
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
      const model = await streams.heldModel({
        initialTool: {
          id: "original-approval-card",
          name: "Bash",
          arguments: { command: "printf 'ORIGINAL_APPROVAL_GUI_DONE'" },
        },
      });
      let host: Host | undefined;
      let session: OriginalSessionView | undefined;
      try {
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "build", planEnabled: false },
        });
        const currentHost = host;
        expect(
          (
            await host.client.request(
              "/api/instance/settings",
              { agentStreamIdleTimeoutMs: 250 },
              "PATCH",
            )
          ).status,
        ).toBe(200);
        await host.command("sendText", { text: "DISPLAY_REAL_APPROVAL" });
        let pending: protocol.PendingInteraction | undefined;
        await vi.waitFor(
          async () => {
            pending = (
              await history.snapshot(fixture, currentHost.sessionId)
            ).pendingInteractions.find(
              (entry) => entry.payload.kind === "permission",
            );
            expect(pending?.payload.kind).toBe("permission");
          },
          { timeout: 30_000 },
        );
        if (pending?.payload.kind !== "permission")
          throw new Error("原审批GUI用例缺少真实等待");
        const allow = pending.payload.options.find(
          (option) => option.response?.decision === "allow",
        );
        if (!allow) throw new Error("原审批没有一次性允许选项");
        session = await renderOriginalSession(fixture, host);
        releaseDom = session.releaseDom;
        const { view } = session;
        await waitFor(
          () =>
            expect(
              view.container.querySelector(
                '[data-permission-option-kind="allowOnce"]',
              ),
            ).not.toBeNull(),
          { timeout: 30_000 },
        );
        expect(view.container.textContent).toContain(
          "ORIGINAL_APPROVAL_GUI_DONE",
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const waiting = await history.snapshot(fixture, host.sessionId);
        expect(waiting.control.phase).toBe("running");
        expect(
          waiting.pendingInteractions.map((entry) => entry.interactionId),
        ).toContain(pending.interactionId);
        const approve = view.container.querySelector(
          '[data-permission-option-kind="allowOnce"]',
        );
        if (!approve) throw new Error("原允许选项已消失");
        fireEvent.click(approve);
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const completed = await history.waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        expect(completed.pendingInteractions).toEqual([]);
        expect(
          completed.rows.window.filter(
            (row) => row.kind === "toolCall" && row.toolName === "Bash",
          ),
        ).toContainEqual(
          expect.objectContaining({
            status: "success",
            output: expect.objectContaining({
              text: expect.stringContaining("ORIGINAL_APPROVAL_GUI_DONE"),
            }),
          }),
        );
        await waitFor(
          () =>
            expect(
              view.container.querySelector(
                '[data-permission-option-kind="allowOnce"]',
              ),
            ).toBeNull(),
          { timeout: 30_000 },
        );
      } finally {
        session?.dispose();
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
