// @vitest-environment node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session";

const server = new URL("../../server/src/features/code-ui/", import.meta.url);

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "真实工作台历史消息编辑",
  () => {
    it("底部编辑可取消，保存后重跑同一 Task 且恢复原草稿", async () => {
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
      const original = "原历史消息";
      const draft = "未发送的独立草稿";
      try {
        const current = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        host = current;
        await host.command("sendText", { text: original });
        await model.firstRequest;
        model.finish(0);
        await vi.waitFor(
          async () => {
            expect(
              (await current.snapshot()).rows.window.some(
                (row: { kind: string; actions?: { canEdit?: boolean } }) =>
                  row.kind === "userInput" && row.actions?.canEdit,
              ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        const before = await host.snapshot();
        const path = join(host.workspacePath, "keep-existing-file.txt");
        await writeFile(path, "编辑历史时保留当前文件");
        ui = await renderOriginalSession(fixture, host, () => {
          vi.stubGlobal("Text", window.Text);
          // JSDOM 没有布局；给滚动容器实际使用的测量接口提供测试窗口大小。
          Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
            configurable: true,
            get(this: HTMLElement) {
              return this.dataset.v4TimelineScroll === "true" ? 800 : 0;
            },
          });
          drafts.persistV4ComposerDraft(
            current.workspacePath,
            JSON.stringify([current.projectId, current.workspacePath]),
            current.sessionId,
            { text: draft },
          );
        });
        const view = ui.view;
        const text = () => view.getByRole("textbox").textContent;
        const begin = async () => {
          fireEvent.click(await view.findByRole("button", { name: /^编辑$/u }));
          await view.findByText("正在编辑历史消息");
          await waitFor(() => expect(text()).toBe(original));
        };
        await waitFor(() => expect(text()).toBe(draft));
        await begin();
        fireEvent.click(view.getByRole("button", { name: "取消编辑" }));
        await waitFor(() => expect(text()).toBe(draft));
        expect((await host.snapshot()).logEpoch).toBe(before.logEpoch);
        await begin();
        const save = await waitFor(() => {
          const button = view.getByRole("button", { name: /^保存$/u });
          expect(button.hasAttribute("disabled")).toBe(false);
          return button;
        });
        fireEvent.click(save);
        await waitFor(() => expect(text()).toBe(draft), { timeout: 15_000 });
        const after = await host.snapshot();
        expect(after.sessionId).toBe(before.sessionId);
        expect(after.logEpoch).not.toBe(before.logEpoch);
        expect(await readFile(path, "utf8")).toBe("编辑历史时保留当前文件");
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 15_000,
        });
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
