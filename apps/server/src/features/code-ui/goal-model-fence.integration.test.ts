import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGoalServiceFixture } from "./goal-service.fixture.js";

type Fixture = Awaited<ReturnType<typeof createGoalServiceFixture>>;
async function root(f: Fixture) {
  return (await f.repository.find(f.scope.instanceId, f.scope.taskId))!;
}
async function completeGoalFixture(f: Fixture) {
  await f.repository.appendEvent(
    f.scope.instanceId,
    f.scope.taskId,
    {
      key: "fixture:goal-verified",
      fingerprint: "fixture:goal-verified",
      event: { type: "fixture.goalVerified" },
    },
    (current) => {
      const state = structuredClone(current.state!);
      const goal = state.goalRecord!;
      state.goalRecord = f.goals.verify(goal, {
        goalId: goal.goalId,
        revision: goal.revision,
        runId: f.runs[0]!.runId,
        evidence: [
          { sourceId: "fixture:actual-text", passed: true, detail: "文字结论" },
        ],
        verdict: { passed: true, reason: "完成解释" },
        at: Date.now(),
      });
      return { state, activeRunId: current.active_run_id };
    },
  );
}

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Code Goal模型快照与替换fence",
  () => {
    it("暂停后修改Task模型选择，普通恢复仍使用Goal创建时的模型与参数", async () => {
      const f = await createGoalServiceFixture();
      try {
        f.provider.models.push({
          ...f.provider.models[0]!,
          id: "second",
          name: "第二模型",
        });
        const service = f.host("frozen-model");
        const command = await f.connect(service);
        const first = await command("sendGoalCommand", { text: "持续解释" });
        await f.waitRuns(1);
        await (await command("pauseGoal", {})).settled;
        await first.settled;
        const current = await root(f);
        const state = structuredClone(current.state!);
        state.snapshots[0]!.config.modelSelection = {
          providerId: f.provider.id,
          modelId: "second",
          options: { reasoningLevel: "high" },
        };
        await f.repository.save(
          f.scope.instanceId,
          f.scope.taskId,
          Number(current.revision),
          state,
          null,
        );
        await (await command("resumeGoal", {})).settled;
        await f.waitRuns(2);
        expect(f.runs[1]!.modelInvocation).toEqual(f.runs[0]!.modelInvocation);
        expect(f.runs[1]!.modelInvocation?.modelId).toBe("test");
        expect(
          (await root(f)).state?.goalModel?.selection.options?.reasoningLevel,
        ).toBe("low");
      } finally {
        await f.close();
      }
    });

    it("供应商修订改变时拒绝普通恢复，显式恢复选择才冻结新修订且不保存凭据", async () => {
      const f = await createGoalServiceFixture();
      try {
        const service = f.host("provider-revision");
        const command = await f.connect(service);
        const first = await command("sendGoalCommand", { text: "持续解释" });
        await f.waitRuns(1);
        await (await command("pauseGoal", {})).settled;
        await first.settled;
        f.provider.configRevision += 1;
        f.provider.models[0]!.extraBody = { temperature: 0.25 };
        await expect(command("resumeGoal", {})).rejects.toThrow(
          "目标模型配置已改变",
        );
        expect(f.runs).toHaveLength(1);
        const paused = await root(f);
        expect(paused.state?.goalRecord?.status).toBe("paused");
        expect(paused.state?.goalModel?.invocation.configRevision).toBe(1);
        await (
          await command("resumeGoal", {}, randomUUID(), {
            expectedGoal: {
              goalId: paused.state!.goalRecord!.goalId,
              revision: paused.state!.goalRecord!.revision,
            },
            resumeModelSelection: {
              providerId: f.provider.id,
              modelId: "test",
              options: { reasoningLevel: "high" },
            },
          })
        ).settled;
        await f.waitRuns(2);
        expect(f.runs[1]!.modelInvocation?.configRevision).toBe(2);
        expect(f.runs[1]!.modelInvocation?.body.temperature).toBe(0.25);
        const stored = JSON.stringify((await root(f)).state);
        expect(stored).not.toContain("credential-only-at-access-boundary");
        expect(stored).not.toContain("credential-header");
      } finally {
        await f.close();
      }
    });

    it("自动续跑前供应商修订改变会持久暂停，不能静默换模型或留下活跃空目标", async () => {
      const f = await createGoalServiceFixture();
      try {
        const service = f.host("auto-provider-revision");
        const command = await f.connect(service);
        const first = await command("sendGoalCommand", { text: "持续解释" });
        await f.waitRuns(1);
        f.provider.configRevision += 1;
        await f.finish(0);
        await first.settled;
        const stored = await root(f);
        expect(f.runs).toHaveLength(1);
        expect(stored.state?.goalRecord?.status).toBe("paused");
        expect(stored.state?.goalRecord?.reason).toBe("goal.modelInvalid");
        expect(
          stored.state?.snapshots[0]?.control.lastError?.message,
        ).toContain("模型配置已改变");
      } finally {
        await f.close();
      }
    });

    it("已完成Goal替换拒绝缺fence及旧客户端；同fence并发只能接纳一次", async () => {
      const f = await createGoalServiceFixture();
      try {
        const service = f.host("goal-replacement");
        const left = await f.connect(service);
        const right = await f.connect(service);
        const first = await left("sendGoalCommand", { text: "解释结果" });
        await f.waitRuns(1);
        await completeGoalFixture(f);
        await f.finish(0);
        await first.settled;
        const complete = (await root(f)).state!.goalRecord!;
        expect(complete.status).toBe("complete");
        await expect(
          left("sendGoalCommand", { text: "缺fence" }, randomUUID(), null),
        ).rejects.toThrow("目标已改变");
        await expect(
          right("sendGoalCommand", { text: "旧客户端" }, randomUUID(), {
            expectedGoal: {
              goalId: complete.goalId,
              revision: complete.revision - 1,
            },
          }),
        ).rejects.toThrow("目标已改变");
        const control = {
          expectedGoal: {
            goalId: complete.goalId,
            revision: complete.revision,
          },
        };
        const results = await Promise.allSettled([
          left("sendGoalCommand", { text: "新目标一" }, randomUUID(), control),
          right("sendGoalCommand", { text: "新目标二" }, randomUUID(), control),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        await f.waitRuns(2);
        expect((await root(f)).state!.goalRecord!.goalId).not.toBe(
          complete.goalId,
        );
        expect(f.runs).toHaveLength(2);
      } finally {
        await f.close();
      }
    });
  },
);
