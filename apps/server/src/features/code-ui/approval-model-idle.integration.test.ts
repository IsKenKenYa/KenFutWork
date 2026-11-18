import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原审批等待与模型空闲计时 integration",
  () => {
    it("实例配置的模型阈值不终止人审等待，原允许后真实Bash与模型完成，下一真实模型停滞才失败", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await heldModel({
        initialTool: {
          id: "wait-human-idle",
          name: "Bash",
          arguments: { command: "printf 'APPROVAL_CAN_CONTINUE'" },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "build", planEnabled: false },
        });
        const currentHost = host;
        const saved = await host.client.request(
          "/api/instance/settings",
          { agentStreamIdleTimeoutMs: 250 },
          "PATCH",
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body).toMatchObject({
          settings: { agentStreamIdleTimeoutMs: 250 },
        });
        await host.command("sendText", { text: "WAIT_HUMAN_PAST_MODEL_IDLE" });
        let pending: protocol.PendingInteraction | undefined;
        await vi.waitFor(
          async () => {
            const value = await snapshot(fixture, currentHost.sessionId);
            pending = value.pendingInteractions.find(
              (entry) => entry.payload.kind === "permission",
            );
            expect(pending?.payload.kind).toBe("permission");
          },
          { timeout: 30_000 },
        );
        if (pending?.payload.kind !== "permission")
          throw new Error("真实执行审批缺失");
        await new Promise((resolve) => setTimeout(resolve, 800));
        const waiting = await snapshot(fixture, host.sessionId);
        expect(waiting.control.phase).toBe("running");
        expect(
          waiting.pendingInteractions.map((entry) => entry.interactionId),
        ).toContain(pending.interactionId);
        expect(
          waiting.rows.window.filter(
            (row) => row.kind === "toolCall" && row.toolName === "Bash",
          ),
        ).toContainEqual(
          expect.objectContaining({ status: "pendingApproval" }),
        );
        const allow = pending.payload.options.find(
          (option) => option.response?.decision === "allow",
        );
        if (!allow) throw new Error("原审批缺少一次性允许选项");
        const allowed = await host.command("resolveInteraction", {
          interactionId: pending.interactionId,
          answer: { optionId: allow.optionId },
        });
        expect(
          protocol.commandAckSchema.parse(allowed.body.result).status,
          JSON.stringify(allowed.body),
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const completed = await waitPhase(
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
              text: expect.stringContaining("APPROVAL_CAN_CONTINUE"),
            }),
          }),
        );
        await host.command("sendText", { text: "STALL_REAL_MODEL_REQUEST" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const failed = await waitPhase(fixture, host.sessionId, "error");
        expect(failed.control.lastError?.message).toContain("没有任何输出");
        expect(model.requests[2]?.closed).toBe(true);
        tools[3] = {
          id: "cancel-human-idle",
          name: "Bash",
          arguments: { command: "printf 'DO_NOT_RUN_CANCELLED_APPROVAL'" },
        };
        await host.command("sendText", { text: "WAIT_APPROVAL_THEN_STOP" });
        let cancellation: protocol.PendingInteraction | undefined;
        await vi.waitFor(
          async () => {
            cancellation = (
              await snapshot(fixture, currentHost.sessionId)
            ).pendingInteractions.find(
              (entry) => entry.payload.kind === "permission",
            );
            expect(cancellation?.payload.kind).toBe("permission");
          },
          { timeout: 30_000 },
        );
        if (cancellation?.payload.kind !== "permission")
          throw new Error("取消用例缺少真实审批");
        const paused = await snapshot(fixture, host.sessionId);
        const execution = paused.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        if (!execution) throw new Error("取消用例缺少真实运行标识");
        expect(
          (
            await host.command("stop", {
              expectedForegroundExecutionId: execution,
            })
          ).body.result.status,
        ).toBe("accepted");
        const stopped = await waitPhase(
          fixture,
          host.sessionId,
          "completedInterrupted",
        );
        expect(stopped.pendingInteractions).toEqual([]);
        const cancelAllow = cancellation.payload.options.find(
          (option) => option.response?.decision === "allow",
        );
        if (!cancelAllow) throw new Error("取消用例缺少原允许选项");
        const late = await host.command("resolveInteraction", {
          interactionId: cancellation.interactionId,
          answer: { optionId: cancelAllow.optionId },
        });
        expect(late.body.result).toMatchObject({
          status: "noop",
          reasonCode: "proto.alreadyResolved",
        });
        expect((await snapshot(fixture, host.sessionId)).control.phase).toBe(
          "completedInterrupted",
        );
        expect(model.requests).toHaveLength(4);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
