import { describe, expect, it } from "vitest";
import { createGoalServiceFixture } from "./goal-service.fixture.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Goal真实CodeUiService跨Run",
  () => {
    it("真实finally自动续跑，用户FIFO先于Goal continuation，Pause取消当前Run", async () => {
      const fixture = await createGoalServiceFixture();
      try {
        const service = fixture.host("goal-host");
        const command = await fixture.connect(service);
        const first = await command("sendGoalCommand", { text: "完成目标" });
        await fixture.waitRuns(1);
        const queued = await command("sendText", { text: "用户优先补充" });
        await queued.settled;
        await fixture.finish(0);
        await first.settled;
        await fixture.waitRuns(2);
        expect(fixture.runs[1]?.prompt).toBe("用户优先补充");
        expect(fixture.runs).toHaveLength(2);
        await fixture.finish(1);
        await fixture.waitRuns(3);
        expect(fixture.runs[2]?.prompt).toContain("继续推进当前目标");
        const pause = await command("pauseGoal", {});
        await pause.settled;
        const stored = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        expect(stored?.state?.goalRecord?.status).toBe("paused");
        expect(stored?.state?.goalRecord?.claimedRunId).toBeNull();
        expect(stored?.active_run_id).toBeNull();
        expect(fixture.runs).toHaveLength(3);
      } finally {
        await fixture.close();
      }
    });
    it("审批阻塞不会自动另起Run，真实终态保留Goal等待状态", async () => {
      const fixture = await createGoalServiceFixture();
      try {
        const service = fixture.host("approval-host");
        const command = await fixture.connect(service);
        const first = await command("sendGoalCommand", { text: "需要审批" });
        await fixture.waitRuns(1);
        await service.onApprovalEvent({
          type: "requested",
          identity: {
            instanceId: fixture.scope.instanceId,
            taskId: fixture.scope.taskId,
            runId: fixture.runs[0]!.runId,
            toolCallId: "write",
            agentId: "main",
            role: "main",
            scopeGeneration: 1,
            branchGeneration: 1,
          },
          parameterFingerprint: "approval-test",
          interaction: {
            interactionId: "approval",
            kind: "permission",
            createdAt: 1,
            anchorRowId: null,
            payload: {
              kind: "permission",
              toolName: "Write",
              toolCallId: "write",
              summary: "写文件",
              detail: {},
              options: [
                {
                  optionId: "allowOnce",
                  label: "允许",
                  kind: "allowOnce",
                  response: { decision: "allow" },
                },
              ],
            },
          },
        });
        expect(
          (await service.getSnapshot(fixture.actor, fixture.scope.taskId))
            .pendingInteractions,
        ).toHaveLength(1);
        expect(fixture.runs).toHaveLength(1);
        await fixture.finish(0);
        await first.settled;
        const root = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        expect(root?.state?.goalRecord?.status).toBe("paused");
        expect(root?.state?.goalRecord?.reason).toBe("interaction.waiting");
        expect(fixture.runs).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });
    it("Stop暂停持久Goal，迟到Stop不暂停新Run，paused目标不能被新目标覆盖", async () => {
      const fixture = await createGoalServiceFixture();
      try {
        const service = fixture.host("stop-host");
        const command = await fixture.connect(service);
        const first = await command("sendGoalCommand", { text: "原目标" });
        await fixture.waitRuns(1);
        const oldRun = fixture.runs[0]!.runId;
        await fixture.finish(0);
        await first.settled;
        await fixture.waitRuns(2);
        const late = await command("stop", {
          expectedForegroundExecutionId: oldRun,
        });
        await late.settled;
        const current = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        expect(current?.state?.goalRecord?.status).toBe("active");
        expect(current?.active_run_id).toBe(fixture.runs[1]!.runId);
        const stop = await command("stop", {
          expectedForegroundExecutionId: fixture.runs[1]!.runId,
        });
        await stop.settled;
        expect(
          (
            await fixture.repository.find(
              fixture.scope.instanceId,
              fixture.scope.taskId,
            )
          )?.state?.goalRecord?.status,
        ).toBe("paused");
        await expect(
          command("sendGoalCommand", { text: "替换目标" }),
        ).rejects.toThrow();
        expect(
          (
            await fixture.repository.find(
              fixture.scope.instanceId,
              fixture.scope.taskId,
            )
          )?.state?.goalRecord?.objective,
        ).toBe("原目标");
        expect(fixture.runs).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    });
    it("真实Service显式预算缺usage终态暂停，不自动续跑或伪称预算可计量", async () => {
      const fixture = await createGoalServiceFixture();
      try {
        const service = fixture.host("budget-host");
        const command = await fixture.connect(service);
        const first = await command("sendGoalCommand", { text: "预算目标" });
        await fixture.waitRuns(1);
        const current = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        await service.hostRpc(fixture.actor, "zcode-session", "setGoalBudget", [
          {
            taskId: fixture.scope.taskId,
            commandId: "explicit-budget",
            revision: current!.state!.goalRecord!.revision,
            tokenBudget: 100,
          },
        ]);
        await fixture.finish(0);
        await first.settled;
        const stored = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        expect(stored?.state?.goalRecord?.status).toBe("paused");
        expect(stored?.state?.goalRecord?.reason).toBe(
          "budget.usageUnavailable",
        );
        expect(stored?.state?.goalRecord?.runUsageObserved).toBe(false);
        expect(fixture.runs).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });
    it("宿主重启只恢复paused事实，用户resume才接纳新的Run", async () => {
      const fixture = await createGoalServiceFixture();
      try {
        const old = fixture.host("same-host");
        const oldCommand = await fixture.connect(old);
        await oldCommand("sendGoalCommand", { text: "持久目标" });
        await fixture.waitRuns(1);
        const restarted = fixture.host("same-host");
        const command = await fixture.connect(restarted);
        const snapshot = await restarted.getSnapshot(
          fixture.actor,
          fixture.scope.taskId,
        );
        expect(snapshot.goal?.status).toBe("paused");
        expect(fixture.runs).toHaveLength(1);
        const persisted = await fixture.repository.find(
          fixture.scope.instanceId,
          fixture.scope.taskId,
        );
        expect(persisted?.state?.goalRecord?.claimedRunId).toBeNull();
        const resume = await command("resumeGoal", {});
        await resume.settled;
        await fixture.waitRuns(2);
        expect(fixture.runs[1]!.runId).not.toBe(fixture.runs[0]!.runId);
        expect(
          (await restarted.getSnapshot(fixture.actor, fixture.scope.taskId))
            .goal?.status,
        ).toBe("active");
        const pause = await command("pauseGoal", {});
        await pause.settled;
      } finally {
        await fixture.close();
      }
    });
  },
);
