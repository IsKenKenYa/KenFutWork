// @vitest-environment node
import { fileURLToPath } from "node:url";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeUiTestClient } from "../../server/src/features/code-ui/host-client.fixture.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type OriginalSessionView,
  renderOriginalSession,
} from "./setup/code-public-session";

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
};
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原SessionPane队列GUI公开接线 integration",
  () => {
    it("原指针拖拽、删除与撤回编辑，立即发送关闭旧模型，停止后原恢复按钮消费剩余输入", async () => {
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
      const model = await streams.heldModel();
      let host: Host | undefined;
      let session: OriginalSessionView | undefined;
      try {
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const currentHost = host;
        await host.command("sendText", { text: "INITIAL_QUEUE_RUN" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        for (const text of [
          "撤回编辑的输入甲",
          "指定立即发送的输入乙",
          "原按钮移除的输入丙",
          "稍后移除的输入丁",
          "拖拽后恢复的输入戊",
        ]) {
          const queued = await host.command("sendText", {
            text,
            requestedDelivery: "queue",
          });
          expect(queued.status, JSON.stringify(queued.body)).toBe(200);
          expect(queued.body.result.result.delivery).toBe("queue");
        }
        const current = await history.snapshot(fixture, host.sessionId);
        const [edit, promote, remove, remainder, resume] = current.queue.items;
        if (!edit || !promote || !remove || !remainder || !resume)
          throw new Error("真实五条排队输入缺失");
        session = await renderOriginalSession(fixture, host);
        const { view } = session;
        releaseDom = session.releaseDom;
        await waitFor(
          () =>
            expect(
              view.getByTestId("v4-queue").getAttribute("data-queue-count"),
            ).toBe("5"),
          { timeout: 30_000 },
        );
        // 仅补浏览器布局这一外部边界；不调用DndContext回调或排序函数。
        const rows = view
          .getByTestId("v4-queue")
          .querySelectorAll("li[data-queue-item-id]");
        for (const [index, row] of Array.from(rows).entries()) {
          const y = 100 + index * 40;
          vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y,
            left: 0,
            top: y,
            width: 400,
            height: 32,
            right: 400,
            bottom: y + 32,
            toJSON: () => ({}),
          });
        }
        const drag = view
          .getByTestId(`v4-queue-item-${resume.queueItemId}`)
          .querySelector<HTMLElement>("[data-v4-queue-drag-handle]");
        if (!drag) throw new Error("原队列缺少指针拖拽手柄");
        const pointer = {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: 20,
        };
        fireEvent.pointerDown(drag, { ...pointer, clientY: 276 });
        fireEvent.pointerMove(document, { ...pointer, clientY: 116 });
        await waitFor(
          () => expect(drag.getAttribute("aria-pressed")).toBe("true"),
          { timeout: 30_000 },
        );
        fireEvent.pointerMove(document, { ...pointer, clientY: 116 });
        fireEvent.pointerUp(document, { ...pointer, buttons: 0, clientY: 116 });
        await vi.waitFor(
          async () =>
            expect(
              (
                await history.snapshot(fixture, currentHost.sessionId)
              ).queue.items.map((item) => item.text),
            ).toEqual([
              resume.text,
              edit.text,
              promote.text,
              remove.text,
              remainder.text,
            ]),
          { timeout: 30_000 },
        );
        await waitFor(
          () =>
            expect(
              view
                .getByTestId(`v4-queue-item-${resume.queueItemId}`)
                .getAttribute("data-index"),
            ).toBe("0"),
          { timeout: 30_000 },
        );
        fireEvent.click(
          view.getByTestId(`v4-queue-item-delete-${remove.queueItemId}`),
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await history.snapshot(fixture, currentHost.sessionId)
              ).queue.items.map((item) => item.text),
            ).toEqual([resume.text, edit.text, promote.text, remainder.text]),
          { timeout: 30_000 },
        );
        await waitFor(
          () => {
            expect(
              view.getByTestId("v4-queue").getAttribute("data-queue-count"),
            ).toBe("4");
            expect(
              view.queryByTestId(`v4-queue-item-${remove.queueItemId}`),
            ).toBeNull();
          },
          { timeout: 30_000 },
        );
        fireEvent.click(
          view.getByTestId(`v4-queue-item-edit-${edit.queueItemId}`),
        );
        await waitFor(
          () => {
            expect(
              view.queryByTestId(`v4-queue-item-${edit.queueItemId}`),
            ).toBeNull();
            expect(view.getByTestId("v4-composer-input").textContent).toContain(
              edit.text,
            );
          },
          { timeout: 30_000 },
        );
        fireEvent.click(
          view.getByTestId(`v4-queue-item-send-now-${promote.queueItemId}`),
        );
        await vi.waitFor(
          () => {
            expect(model.requests).toHaveLength(2);
            expect(model.requests[0]?.closed).toBe(true);
          },
          { timeout: 30_000 },
        );
        await waitFor(
          () =>
            expect(
              view.queryByTestId(`v4-queue-item-${promote.queueItemId}`),
            ).toBeNull(),
          { timeout: 30_000 },
        );
        const promoted = await history.snapshot(fixture, host.sessionId);
        expect(
          promoted.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["INITIAL_QUEUE_RUN", promote.text]);
        await waitFor(
          () =>
            expect(
              Number(
                view
                  .getByTestId("v4-session-pane-actual-queue-pane")
                  .getAttribute("data-projection-seq"),
              ),
            ).toBeGreaterThanOrEqual(promoted.seq),
          { timeout: 30_000 },
        );
        // 撤回文本仍在composer，原UI显示发送按钮；Esc保留草稿并停止运行。
        fireEvent.keyDown(window, { key: "Escape" });
        await waitFor(
          () =>
            expect(
              view
                .getByTestId("v4-queue")
                .getAttribute("data-queue-auto-drain"),
            ).toBe("false"),
          { timeout: 30_000 },
        );
        const paused = await history.snapshot(fixture, host.sessionId);
        expect(paused.control.phase).toBe("completedInterrupted");
        expect(paused.queue.items.map((item) => item.text)).toEqual([
          resume.text,
          remainder.text,
        ]);
        fireEvent.click(view.getByTestId("v4-queue-resume"));
        await vi.waitFor(
          async () => {
            expect(model.requests).toHaveLength(3);
            expect(model.requests[1]?.closed).toBe(true);
            const started = await history.snapshot(
              fixture,
              currentHost.sessionId,
            );
            expect(started.queue.items.map((item) => item.text)).toEqual([
              remainder.text,
            ]);
            expect(
              started.rows.window
                .filter((row) => row.kind === "userInput")
                .map((row) => row.text),
            ).toEqual(["INITIAL_QUEUE_RUN", promote.text, resume.text]);
          },
          { timeout: 30_000 },
        );
        fireEvent.click(
          view.getByTestId(`v4-queue-item-delete-${remainder.queueItemId}`),
        );
        await vi.waitFor(
          async () =>
            expect(
              (await history.snapshot(fixture, currentHost.sessionId)).queue
                .items,
            ).toEqual([]),
          { timeout: 30_000 },
        );
        await waitFor(() => expect(view.queryByTestId("v4-queue")).toBeNull(), {
          timeout: 30_000,
        });
        view.unmount();
      } finally {
        cleanup();
        session?.dispose();
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
