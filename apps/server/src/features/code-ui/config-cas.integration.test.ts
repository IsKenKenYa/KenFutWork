import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原配置CAS应答 integration",
  () => {
    it("旧revision返回原stale且不改配置，同键重放不重复写，客户端用新revision真实重试", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: "CREATE_CONFIGURATION_TARGET" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        const initial = await snapshot(fixture, host.sessionId);
        const first = await host.command(
          "setFollowupMode",
          { mode: "guide" },
          randomUUID(),
          {
            baseRevision: initial.revision,
            baseLogEpoch: initial.logEpoch,
          },
        );
        expect(protocol.commandAckSchema.parse(first.body.result).status).toBe(
          "accepted",
        );
        const changed = await snapshot(fixture, host.sessionId);
        expect(changed.config.followupMode).toBe("guide");
        const metaParams = {
          taskId: host.sessionId,
          workspacePath: host.workspacePath,
        };
        const metaBefore = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "getTaskMeta",
          args: [metaParams],
        });
        expect(metaBefore.status).toBe(200);
        expect(metaBefore.body.result).toMatchObject({
          taskId: host.sessionId,
          updatedAt: expect.any(Number),
        });
        const staleId = randomUUID();
        const stale = await host.command(
          "setFollowupMode",
          { mode: "queue" },
          staleId,
          {
            baseRevision: initial.revision,
            baseLogEpoch: initial.logEpoch,
          },
        );
        const ack = protocol.commandAckSchema.parse(stale.body.result);
        expect(ack).toMatchObject({
          status: "stale",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: changed.revision,
        });
        const unchanged = await snapshot(fixture, host.sessionId);
        expect(unchanged.config.followupMode).toBe("guide");
        expect(unchanged.revision).toBe(changed.revision);
        const metaAfter = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "getTaskMeta",
          args: [metaParams],
        });
        expect(metaAfter.body.result.updatedAt).toBe(
          metaBefore.body.result.updatedAt,
        );
        const replay = await host.command(
          "setFollowupMode",
          { mode: "queue" },
          staleId,
          {
            baseRevision: initial.revision,
            baseLogEpoch: initial.logEpoch,
          },
        );
        expect(
          protocol.commandAckSchema.parse(replay.body.result),
        ).toMatchObject({
          status: "duplicate",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: changed.revision,
        });
        const retry = await host.command(
          "setFollowupMode",
          { mode: "queue" },
          randomUUID(),
          {
            baseRevision: ack.revisionAtDecision,
            baseLogEpoch: initial.logEpoch,
          },
        );
        expect(protocol.commandAckSchema.parse(retry.body.result).status).toBe(
          "accepted",
        );
        const current = await snapshot(fixture, host.sessionId);
        expect(current.config.followupMode).toBe("queue");
        expect(current.revision).toBe(changed.revision + 1);
        const epoch = await host.command(
          "setFollowupMode",
          { mode: "guide" },
          randomUUID(),
          {
            baseRevision: current.revision,
            baseLogEpoch: randomUUID(),
          },
        );
        expect(
          protocol.commandAckSchema.parse(epoch.body.result),
        ).toMatchObject({
          status: "stale",
          reasonCode: "proto.staleLogEpoch",
          revisionAtDecision: current.revision,
        });
        expect(
          (await snapshot(fixture, host.sessionId)).config.followupMode,
        ).toBe("queue");
        expect(model.requests).toHaveLength(1);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
