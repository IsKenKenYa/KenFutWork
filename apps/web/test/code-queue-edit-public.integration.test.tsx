// @vitest-environment node
import { fileURLToPath } from "node:url";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session";

const server = new URL("../../server/src/features/code-ui/", import.meta.url);

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原工作台排队消息编辑 integration",
  () => {
    it("打开排队消息不删除它，取消与保存均恢复原草稿", async () => {
      const [
        { createCodeUiHttpFixture },
        { createCodeSessionFixture },
        { heldModel },
        drafts,
      ] = await Promise.all([
        import(
          fileURLToPath(new URL("code-ui-http.fixture.ts", server))
        ) as Promise<{ createCodeUiHttpFixture(): Promise<PublicFixture> }>,
        import(
          fileURLToPath(new URL("host-session.fixture.ts", server))
        ) as Promise<
          typeof import("../../server/src/features/code-ui/host-session.fixture.js")
        >,
        import(
          fileURLToPath(new URL("model-stream.fixture.ts", server))
        ) as Promise<
          typeof import("../../server/src/features/code-ui/model-stream.fixture.js")
        >,
        import("@zui/v4/composer/composerDraftStore.js"),
      ]);
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      let ui: Awaited<ReturnType<typeof renderOriginalSession>> | undefined;
      const queuedText = "正在等待发送的排队消息";
      const draftText = "需要保留的原草稿";
      try {
        const openedHost = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        host = openedHost;
        await host.command("sendText", { text: "尚未结束的前台工作" });
        await model.firstRequest;
        await host.command("sendText", { text: queuedText });
        const before = (await host.snapshot()).queue.items[0];
        ui = await renderOriginalSession(fixture, host, () => {
          vi.stubGlobal("Text", window.Text);
          drafts.persistV4ComposerDraft(
            openedHost.workspacePath,
            JSON.stringify([openedHost.projectId, openedHost.workspacePath]),
            openedHost.sessionId,
            { text: draftText },
          );
        });
        const view = ui.view;
        const text = () => view.getByRole("textbox").textContent;
        const beginEdit = async () => {
          fireEvent.click(await view.findByRole("button", { name: /^编辑$/u }));
          await waitFor(() => expect(text()).toBe(queuedText));
          expect((await openedHost.snapshot()).queue.items[0]).toMatchObject({
            queueItemId: before.queueItemId,
            editLock: { clientId: openedHost.clientId },
          });
        };
        await waitFor(() => expect(text()).toBe(draftText));
        await beginEdit();
        fireEvent.click(view.getByRole("button", { name: "取消编辑" }));
        await waitFor(() => expect(text()).toBe(draftText));
        expect((await host.snapshot()).queue.items[0].editLock).toBeUndefined();
        await beginEdit();
        const submit = await waitFor(
          () => {
            const button = view.getByRole("button", {
              name: /^保存$/u,
            });
            expect(button.hasAttribute("disabled")).toBe(false);
            return button;
          },
          { timeout: 10_000 },
        );
        fireEvent.click(submit);
        await waitFor(() => expect(text()).toBe(draftText));
        expect((await host.snapshot()).queue.items).toMatchObject([
          {
            queueItemId: before.queueItemId,
            text: queuedText,
            sourceCommandId: before.sourceCommandId,
          },
        ]);
        expect((await host.snapshot()).queue.items[0].editLock).toBeUndefined();
        expect(model.requests).toHaveLength(1);
      } finally {
        ui?.dispose();
        ui?.releaseDom();
        vi.unstubAllGlobals();
        if (host) {
          if ((await host.snapshot()).control.canStop)
            await host.command("stop", {});
          await host.dispose();
        }
        await model.close();
        await fixture.close();
      }
    }, 90_000);
  },
);
