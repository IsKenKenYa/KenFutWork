import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "../features/code-ui/code-ui-http.fixture.js";
import { createCodeSessionFixture } from "../features/code-ui/host-session.fixture.js";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "HTTP Code/Design统一准入 integration",
  () => {
    it("真实HTTP/PG输入进原V4同Task队列；Code/Design沿同一宿主，旧模式和素材参数不启动模型", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const shared = await fixture.client.request(
          `/api/projects/${host.projectId}`,
          { enabled_modes: ["code", "design"] },
          "PATCH",
        );
        expect(shared.status).toBe(204);
        const payload = {
          sessionId: host.sessionId,
          taskId: host.sessionId,
          projectId: host.projectId,
          conversationId: host.sessionId,
          prompt: "真实Code输入",
          inputId: randomUUID(),
          workContext: { preset: "code" },
        };
        const accepted = await fixture.client.request(
          "/api/agent/runs",
          payload,
        );
        expect(accepted.status).toBe(202);
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30000,
        });
        const queued = await fixture.client.request("/api/agent/runs", {
          ...payload,
          inputId: randomUUID(),
          prompt: "同Task Design输入",
          workContext: { preset: "design" },
        });
        expect(queued.status).toBe(202);
        const snapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(snapshot.queue.items).toMatchObject([
          { text: "同Task Design输入", workContext: { preset: "design" } },
        ]);
        expect(model.requests).toHaveLength(1);
        const legacyMode = await fixture.client.request("/api/agent/runs", {
          ...payload,
          inputId: randomUUID(),
          executionMode: "plan",
        });
        expect(legacyMode.status).toBe(409);
        const legacyAttachment = await fixture.client.request(
          "/api/agent/runs",
          {
            ...payload,
            inputId: randomUUID(),
            attachments: [
              {
                assetId: "old",
                url: "https://example.com/old.png",
                mimeType: "image/png",
              },
            ],
          },
        );
        expect(legacyAttachment.status).toBe(409);
        expect(model.requests).toHaveLength(1);
        expect(
          (
            await fixture.client.request(
              `/api/agent/runs/${accepted.body.runId}/cancel`,
              {},
            )
          ).status,
        ).toBe(202);
        await vi.waitFor(
          async () => {
            const stopped = protocol.conversationSnapshotSchema.parse(
              await host!.snapshot(),
            );
            expect(stopped.control.phase).toBe("completedInterrupted");
            expect(stopped.queue.items).toHaveLength(1);
          },
          { timeout: 30000 },
        );
      } finally {
        await host?.dispose();
        await fixture.close();
        await model.close();
      }
    }, 90000);
  },
);
