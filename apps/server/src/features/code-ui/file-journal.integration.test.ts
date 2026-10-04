import { randomUUID } from "node:crypto";
import type {
  zcodeUiProtocol as protocol,
  StreamEvent,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "文件提交日志 integration",
  () => {
    it("读取指定Task/Run的真实持久提交，预算越界、跨工作区与删除后迟到读取均拒绝", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const { scope } = database.context;
        const repository = createCodeUiRepository(database.persistence);
        const runId = randomUUID();
        const host = createCodeUiConversation({
          sessionId: scope.taskId,
          workspacePath: scope.rootDirectory,
          config: {
            provider: "zcode",
            model: "",
            thought: "",
            followupMode: "queue",
          },
        });
        host.startTurn({ runId, commandId: "human-source", text: "修改文件" });
        await repository.save(
          scope.workspaceId,
          scope.taskId,
          0,
          host.exportState(),
          null,
        );
        const event: Extract<StreamEvent, { type: "tool.completed" }> = {
          type: "tool.completed",
          runId,
          toolCallId: "native-edit",
          toolName: "Edit",
          status: "success",
          timestamp: "2026-10-04T00:00:00.000Z",
          output: {
            filePath: `${scope.rootDirectory}/a.txt`,
            type: "update",
            originalFile: "before\n",
            content: "after\n",
            version: "committed-native-version",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-before", "+after"],
              },
            ],
          },
        };
        const append = (key: string, payload: unknown) =>
          repository.appendEvent(
            scope.workspaceId,
            scope.taskId,
            { key, fingerprint: key, event: payload },
            (root) => ({ state: root.state!, activeRunId: null }),
          );
        await append("native-edit", event);
        await append("other-run", { ...event, runId: randomUUID() });
        await append("started", {
          type: "tool.started",
          runId,
          toolCallId: "read",
          toolName: "Read",
          timestamp: event.timestamp,
        });
        await append("large-read-completed", {
          ...event,
          toolCallId: "large-read",
          toolName: "Read",
          output: { content: "x".repeat(20000) },
        });
        const limits = { maxEvents: 10, maxBytes: 10000 };
        expect(
          await repository.readToolCompletions(
            scope.workspaceId,
            scope.taskId,
            runId,
            limits,
          ),
        ).toEqual([event]);
        await expect(
          repository.readToolCompletions(
            scope.workspaceId,
            scope.taskId,
            runId,
            { ...limits, maxBytes: 1 },
          ),
        ).rejects.toMatchObject({ code: "command_conflict" });
        await expect(
          repository.readToolCompletions(
            randomUUID(),
            scope.taskId,
            runId,
            limits,
          ),
        ).rejects.toMatchObject({ code: "not_found" });
        await append("second-native-edit", {
          ...event,
          toolCallId: "second-native-edit",
        });
        await expect(
          repository.readToolCompletions(
            scope.workspaceId,
            scope.taskId,
            runId,
            { ...limits, maxEvents: 1 },
          ),
        ).rejects.toMatchObject({ code: "command_conflict" });
        const steps: string[] = [];
        const envelope: protocol.CommandEnvelope = {
          clientId: randomUUID(),
          commandId: randomUUID(),
          sessionId: scope.taskId,
          type: "switchCollaborationMode",
          payload: { mode: "plan" },
          issuedAt: Date.now(),
        };
        await repository.applyScopeCommand(
          scope.workspaceId,
          envelope,
          "scope-receipt-order",
          async () => {
            steps.push("changed");
          },
          (root) => ({
            state: root.state!,
            ack: {
              commandId: envelope.commandId,
              status: "accepted",
              revisionAtDecision: Number(root.revision),
            },
          }),
          async () => {
            const receipt = await repository.queryCommands(
              scope.workspaceId,
              envelope.clientId,
              [{ commandId: envelope.commandId, sessionId: scope.taskId }],
            );
            expect(receipt.results[0]?.result).toMatchObject({
              status: "accepted",
            });
            steps.push("after-committed");
          },
        );
        expect(steps).toEqual(["changed", "after-committed"]);
        await repository.delete(scope.workspaceId, scope.taskId);
        await expect(
          repository.readToolCompletions(
            scope.workspaceId,
            scope.taskId,
            runId,
            limits,
          ),
        ).rejects.toMatchObject({ code: "not_found" });
      } finally {
        await database.close();
      }
    });
  },
);
