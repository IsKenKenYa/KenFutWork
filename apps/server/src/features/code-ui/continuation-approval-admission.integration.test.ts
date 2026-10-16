import { describe, expect, it, vi } from "vitest";
import { createTaskWorkManager } from "../task-work/service.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import { createGoalServiceFixture } from "./goal-service.fixture.js";

// PG、原V4接纳和Goal/TaskWork生命周期真实；Harness端口仅控制Run完成时点。
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "自动续跑基础权限接纳 integration",
  () => {
    it("Goal continuation在接纳边界持有基础build上限并交给Harness", async () => {
      const f = await createGoalServiceFixture();
      try {
        const command = await f.connect(f.host("goal-permission-admission"));
        await command("sendGoalCommand", { text: "核对项目并完成目标" });
        await f.waitRuns(1);
        expect(f.runs[0]!.approvalCeiling).toBe("build");
        await f.finish(0);
        await f.waitRuns(2);
        expect(f.runs[1]!.prompt).toContain("继续推进当前目标");
        expect(f.runs[1]!.approvalCeiling).toBe("build");
      } finally {
        await f.close();
      }
    });

    it("后台结果触发的新Run在接纳边界持有基础build上限并交给Harness", async () => {
      const f = await createGoalServiceFixture();
      const context = {
        actor: f.actor,
        scope: f.scope,
        agentId: "main",
        runId: "background-origin",
        branchGeneration: 1,
      };
      const work = createTaskWorkManager({
        store: createMemoryTaskWorkStore([context]),
        executionHostId: "background-permission-admission",
        resolveMaxConcurrent: async () => 1,
      });
      try {
        const host = f.host(
          "background-permission-admission",
          undefined,
          undefined,
          work,
        );
        await f.connect(host);
        await host.getSnapshot(f.actor, f.scope.taskId);
        await work.start(
          context,
          {
            kind: "command",
            label: "目录核对",
            toolCallId: "background-read",
          },
          {
            run: async () => ({ status: "completed", summary: "核对完成" }),
            stop: async () => {},
          },
        );
        await vi.waitFor(async () => {
          expect((await work.list(context))[0]?.status).toBe("completed");
        });
        expect(
          await host.resumeTaskWork(f.scope.instanceId, f.scope.taskId),
        ).toBe(true);
        await f.waitRuns(1);
        expect(f.runs[0]!.prompt).toContain("后台工作已有终态结果");
        expect(f.runs[0]!.approvalCeiling).toBe("build");
      } finally {
        await f.close();
        await work.close("权限接纳回归结束");
      }
    });
  },
);
