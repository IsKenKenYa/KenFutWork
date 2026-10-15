import { randomUUID } from "node:crypto";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import type { CodeAdmittedInput } from "./input-intents.js";
import { createCodeUiRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "统一Task真实持久权威",
  () => {
    it("Design默认项目的共享Task仍持有唯一固定目录，模式撤回阻止旧Design派发而Code身份保留", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const original = database.context.scope;
        const sql = database.persistence.forInstance(original.instanceId);
        await sql.execute(
          "update public.projects set kind='design',enabled_modes=array['design','code']::text[] where instance_id=:instance and id=$1",
          [original.projectId],
        );
        const sessionId = randomUUID();
        const scope = { ...original, taskId: sessionId };
        const repository = createCodeUiRepository(database.persistence);
        const host = createCodeUiConversation({
          sessionId,
          workspacePath: scope.rootDirectory,
          config: {
            provider: "zcode",
            model: "test",
            thought: "",
            followupMode: "queue",
          },
          workContext: { preset: "design" },
        });
        await repository.createRoot(scope.instanceId, {
          sessionId,
          projectId: scope.projectId,
          scope,
          createdByClientId: database.actor.accessClientId,
          threadId: `unified:${randomUUID()}`,
          state: host.exportState(),
          command: {
            clientId: "fixture",
            commandId: randomUUID(),
            fingerprint: randomUUID(),
          },
        });
        const scopeRepository = createScopeRepository(database.persistence);
        expect(
          await scopeRepository.load(scope.instanceId, sessionId),
        ).toMatchObject({
          preset: "code",
          scope: {
            taskId: sessionId,
            projectId: scope.projectId,
            rootDirectory: scope.rootDirectory,
          },
        });
        const runId = randomUUID();
        const commandId = randomUUID();
        const envelope: protocol.CommandEnvelope = {
          clientId: "fixture",
          commandId,
          sessionId,
          type: "sendText",
          payload: { text: "绘制", workContext: { preset: "design" } },
          issuedAt: 0,
        };
        await repository.applyCommand(
          scope.instanceId,
          envelope,
          "stable-input",
          (root) => {
            const current = createCodeUiConversation({
              sessionId,
              workspacePath: scope.rootDirectory,
              config: host.getSnapshot().config,
              state: root.state!,
            });
            const input: CodeAdmittedInput = {
              runId,
              scopeGeneration: 1,
              branchGeneration: 1,
              status: "active",
              modelInvocation: {
                providerId: "fixture",
                modelId: "test",
                configRevision: 1,
                body: {},
                inputCapabilities: { image: false, pdf: false },
              },
              intent: {
                clientId: "fixture",
                sourceCommandId: commandId,
                queueItemId: randomUUID(),
                kind: "sendText",
                text: "绘制",
                attachments: [],
                workContext: { preset: "design" },
                delivery: { requested: "auto", admitted: "startNow" },
                order: { admissionSeq: 1 },
                steer: { state: "notRequested" },
                dispatch: { state: "admitted" },
                admittedAt: 0,
              },
            };
            current.admitInput(input);
            current.startInput(input);
            return {
              state: current.exportState(),
              activeRunId: runId,
              ack: {
                commandId,
                status: "accepted",
                revisionAtDecision: current.getSnapshot().revision,
              },
            };
          },
        );
        const replay = await repository.applyCommand(
          scope.instanceId,
          envelope,
          "stable-input",
          () => {
            throw new Error("duplicate must not readmit");
          },
        );
        expect(replay.status).toBe("duplicate");
        await expect(
          repository.applyCommand(
            scope.instanceId,
            envelope,
            "changed-input",
            () => {
              throw new Error("conflict must not readmit");
            },
          ),
        ).rejects.toMatchObject({ code: "command_conflict" });
        await sql.execute(
          "update public.projects set kind='code',enabled_modes=array['code']::text[] where instance_id=:instance and id=$1",
          [scope.projectId],
        );
        let started = false;
        expect(
          await repository.startRunIfCurrent(
            scope.instanceId,
            sessionId,
            runId,
            { scopeGeneration: 1, branchGeneration: 1, inputRequired: true },
            () => {
              started = true;
            },
          ),
        ).toBe(false);
        expect(started).toBe(false);
        const cold = await repository.find(scope.instanceId, sessionId);
        expect(cold?.state?.inputs).toHaveLength(1);
        expect(cold?.state?.inputs?.[0]?.intent.workContext).toEqual({
          preset: "design",
        });
        expect(
          await scopeRepository.load(scope.instanceId, sessionId),
        ).toMatchObject({
          preset: "code",
          scope: { rootDirectory: scope.rootDirectory, generation: 1 },
        });
        expect(
          await sql.queryOne(
            "select task_kind,code_task_id,design_task_id from public.execution_task_owners where instance_id=:instance and task_id=$1",
            [sessionId],
          ),
        ).toMatchObject({
          task_kind: "code",
          code_task_id: sessionId,
          design_task_id: null,
        });
      } finally {
        await database.close();
      }
    });
  },
);
