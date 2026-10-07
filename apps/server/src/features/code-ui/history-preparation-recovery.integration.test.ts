import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { restartCodeUiHttpFixture } from "./code-ui-restart.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "分叉准备启动核对 integration",
  () => {
    it("实际fork COMMIT成功但全部回包/核对不可用，冷服务保留已发表Task并撤销原生清理权，不重放模型", async () => {
      let proxy:
        | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
        | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const model = await heldModel();
      let host: Host | undefined;
      let cold:
        | Awaited<ReturnType<typeof restartCodeUiHttpFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", {
          text: "PUBLISHED_FORK_UNCERTAIN_PREPARATION",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        const source = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const target = source.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!target?.entityId || !proxy)
          throw new Error("源回复或实际PG故障代理缺失");
        const commandId = randomUUID();
        proxy.arm(commandId, { blackoutAfterCommit: true });
        const uncertain = await host.command(
          "forkAssistant",
          { target: { rowId: target.rowId, entityId: target.entityId } },
          commandId,
          { baseRevision: source.revision, baseLogEpoch: source.logEpoch },
        );
        expect(proxy.evidence().injected).toMatchObject({
          commitConfirmed: true,
          replySuppressed: true,
          commandId,
        });
        expect(uncertain.status).toBe(409);
        expect(JSON.stringify(uncertain.body)).toContain("发表结果尚未确认");
        proxy.restore();
        cold = await restartCodeUiHttpFixture(fixture, {
          clientId: host.clientId,
        });
        const queried = await cold.stream.rpc("queryConversationCommandsV4", [
          {
            workspacePath: host.workspacePath,
            commands: [{ sessionId: host.sessionId, commandId }],
          },
        ]);
        const ack = queried.body.result.results[0].result;
        expect(ack).toMatchObject({
          status: "accepted",
          result: { type: "forkAssistant" },
        });
        const forkId = ack.result.sessionId;
        expect(
          JSON.stringify((await snapshot(fixture, forkId)).rows.window),
        ).toContain("PUBLISHED_FORK_UNCERTAIN_PREPARATION");
        const binding = await cold.app.kernel
          .get("threads")
          .resolveOwnedSessionThread(fixture.actor, forkId);
        expect(
          await cold.app.kernel
            .get("agentRuns")
            .getContextBranchPreparation(binding.threadId),
        ).toBeNull();
        expect(model.requests).toHaveLength(1);
      } finally {
        proxy?.restore();
        if (cold && host)
          await cold.client.request(
            `/api/projects/${host.projectId}`,
            undefined,
            "DELETE",
          );
        else if (host) await host.dispose();
        await cold?.close();
        await model.close();
        await fixture.close();
      }
    }, 180_000);
    it("实际发表事务断线回滚且核对不可用，冷服务清理未发表原生目标并结算中断，不重放命令", async () => {
      let proxy:
        | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
        | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const model = await heldModel();
      let host: Host | undefined;
      let cold:
        | Awaited<ReturnType<typeof restartCodeUiHttpFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", {
          text: "UNPUBLISHED_PREPARATION_MUST_NOT_REPLAY",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        const source = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const target = source.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!target?.entityId || !proxy)
          throw new Error("实际回复与PG代理未装配");
        const commandId = randomUUID();
        proxy.arm(commandId, { rollbackBeforeCommit: true });
        const uncertain = await host.command(
          "forkAssistant",
          { target: { rowId: target.rowId, entityId: target.entityId } },
          commandId,
          { baseRevision: source.revision, baseLogEpoch: source.logEpoch },
        );
        expect(uncertain.status).toBe(409);
        const evidence = proxy.evidence().injected;
        expect(evidence).toMatchObject({
          commitConfirmed: false,
          replySuppressed: true,
          readbackSuppressed: true,
        });
        if (!evidence?.targetTaskId || !evidence.targetThreadId)
          throw new Error("PG字节观察没有实际目标身份");
        proxy.restore();
        cold = await restartCodeUiHttpFixture(fixture, {
          clientId: host.clientId,
        });
        const queried = await cold.stream.rpc("queryConversationCommandsV4", [
          {
            workspacePath: host.workspacePath,
            commands: [{ sessionId: host.sessionId, commandId }],
          },
        ]);
        expect(queried.body.result.results[0].result).toMatchObject({
          status: "failed",
          reasonCode: "guard.preparationInterrupted",
        });
        expect(
          (
            await cold.client.request(
              `/api/code-ui/sessions/${evidence.targetTaskId}`,
            )
          ).status,
        ).toBe(404);
        expect(
          await cold.app.kernel
            .get("agentRuns")
            .getContextBranchPreparation(evidence.targetThreadId),
        ).toBeNull();
        expect(model.requests).toHaveLength(1);
        expect(
          JSON.stringify((await snapshot(fixture, host.sessionId)).rows.window),
        ).toContain("UNPUBLISHED_PREPARATION_MUST_NOT_REPLAY");
      } finally {
        proxy?.restore();
        if (cold && host)
          await cold.client.request(
            `/api/projects/${host.projectId}`,
            undefined,
            "DELETE",
          );
        else if (host) await host.dispose();
        await cold?.close();
        await model.close();
        await fixture.close();
      }
    }, 180_000);
  },
);
