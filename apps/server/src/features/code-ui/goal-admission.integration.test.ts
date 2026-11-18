import { randomUUID } from "node:crypto";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createGoalService } from "../goals/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { claimGoalContinuation } from "./goal-admission.js";
import { pauseTaskGoal } from "./goals.js";
import { createCodeUiRepository } from "./repository.js";

const config = {
  provider: "zcode",
  model: "test",
  thought: "",
  followupMode: "queue" as const,
};
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Goal真实Task事务admission",
  () => {
    it("同一Goal revision仅一Run获准；stop暂停与Task状态同事务，冷读保留事实", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const scope = database.context.scope;
        const repository = createCodeUiRepository(database.persistence);
        const host = createCodeUiConversation({
          sessionId: scope.taskId,
          workspacePath: scope.rootDirectory,
          config,
        });
        host.setGoal(
          createGoalService().create(null, {
            goalId: "goal",
            objective: "真实验收",
            branchGeneration: 1,
            at: 0,
          }),
        );
        await repository.save(
          scope.instanceId,
          scope.taskId,
          0,
          host.exportState(),
          null,
        );
        const envelope = (commandId: string): protocol.CommandEnvelope => ({
          clientId: "goal-test",
          commandId,
          sessionId: scope.taskId,
          type: "sendText",
          payload: { text: "continue" },
          issuedAt: 0,
        });
        const admissions = await Promise.allSettled(
          [1, 2].map(async () => {
            const runId = randomUUID();
            const command = envelope(runId);
            return repository.applyCommand(
              scope.instanceId,
              command,
              runId,
              (root) => {
                return claimGoalContinuation(
                  root,
                  {
                    goalId: "goal",
                    revision: 1,
                    runId,
                    commandId: runId,
                    text: "continue",
                    owner: { hostId: "test", runtimeId: "test-runtime" },
                    at: 0,
                  },
                  createGoalService(),
                );
              },
            );
          }),
        );
        expect(
          admissions.filter((item) => item.status === "fulfilled"),
        ).toHaveLength(1);
        const running = await repository.find(scope.instanceId, scope.taskId);
        expect(running?.state?.goalRecord?.claimedRunId).toBe(
          running?.active_run_id,
        );
        await repository.appendEvent(
          scope.instanceId,
          scope.taskId,
          { key: "stop", fingerprint: "stop", event: { type: "goal.stop" } },
          (root) => {
            const state = structuredClone(root.state!);
            pauseTaskGoal(
              state,
              root.id,
              "user.stop",
              1000,
              createGoalService(),
            );
            return { state, activeRunId: root.active_run_id };
          },
        );
        const cold = await createCodeUiRepository(database.persistence).find(
          scope.instanceId,
          scope.taskId,
        );
        expect(cold?.state?.goalRecord?.status).toBe("paused");
        expect(cold?.state?.snapshots[0]?.goal?.status).toBe("paused");
        expect(cold?.active_run_id).toBe(running?.active_run_id);
      } finally {
        await database.close();
      }
    });
  },
);
