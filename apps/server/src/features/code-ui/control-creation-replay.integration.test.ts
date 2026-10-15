import { randomUUID } from "node:crypto";
import {
  type CodeGoalControl,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCanvasRepository } from "../canvas/repository.js";
import { createGoalServiceFixture } from "./goal-service.fixture.js";
import { codeUiCommandFingerprint } from "./service.js";
import type { ConversationWorkContextProvider } from "./work-context.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Goal控制与创建原RPC回执重放 integration",
  () => {
    it("Goal恢复首响应丢失后模型变动，同命令只返回原receipt，不再次恢复/捕获能力；不同控制或实例拒绝", async () => {
      const f = await createGoalServiceFixture();
      try {
        const capture = vi.fn((preset: "code" | "design") => ({
          version: 1 as const,
          preset,
          entries: [],
        }));
        const service = f.host("goal-control-replay", capture);
        const command = await f.connect(service);
        await command("sendGoalCommand", { text: "继续解释" });
        await f.waitRuns(1);
        await (await command("pauseGoal", {})).settled;
        const pausedRow = await f.repository.find(
          f.scope.instanceId,
          f.scope.taskId,
        );
        if (!pausedRow?.state?.goalRecord) throw new Error("测试前置缺失");
        const paused = pausedRow.state.goalRecord;
        const control: CodeGoalControl = {
          expectedGoal: { goalId: paused.goalId, revision: paused.revision },
        };
        const commandId = randomUUID();
        // 服务端已接纳；客户端未消费第一次响应，重连仍重用完整原请求。
        const original = await command("resumeGoal", {}, commandId, control);
        await original.settled;
        await f.waitRuns(2);
        f.provider.enabled = false;
        f.provider.configRevision += 1;
        const replayRow = await f.repository.find(
          f.scope.instanceId,
          f.scope.taskId,
        );
        if (!replayRow) throw new Error("测试前置缺失");
        const before = structuredClone(replayRow.state);
        const captures = capture.mock.calls.length;
        const duplicate = await command("resumeGoal", {}, commandId, control);
        await duplicate.settled;
        expect(duplicate.result).toEqual({
          ...protocol.commandAckSchema.parse(original.result),
          status: "duplicate",
        });
        await expect(
          command("pauseGoal", {}, commandId, control),
        ).rejects.toMatchObject({ code: "command_conflict" });
        await expect(
          service.transportRpc(
            { ...f.actor, instanceId: randomUUID() },
            command.connectionId,
            "sendConversationCommandV4",
            [
              {
                workspacePath: f.scope.rootDirectory,
                goalControl: control,
                envelope: {
                  clientId: command.clientId,
                  commandId,
                  sessionId: f.scope.taskId,
                  type: "resumeGoal",
                  payload: {},
                  issuedAt: 0,
                },
              },
            ],
          ),
        ).rejects.toThrow();
        expect(capture).toHaveBeenCalledTimes(captures);
        expect(f.runs).toHaveLength(2);
        expect(
          (await f.repository.find(f.scope.instanceId, f.scope.taskId))?.state,
        ).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it("创建首响应丢失后删除画布/模型停用仍返回同一真实Task，null-session沿创建事务核指纹与项目归属", async () => {
      const f = await createGoalServiceFixture();
      try {
        const sql = f.database.persistence.forInstance(f.scope.instanceId);
        await sql.execute(
          "update public.projects set enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
          [f.scope.projectId],
        );
        const canvases = createCanvasRepository(f.database.persistence);
        const canvas = await canvases.create({
          instanceId: f.scope.instanceId,
          projectId: f.scope.projectId,
          canvasId: randomUUID(),
          name: "创建引用",
        });
        if (!canvas) throw new Error("真实文档未创建");
        const prepare = vi.fn(
          async (
            input: Parameters<ConversationWorkContextProvider["prepare"]>[0],
          ) => {
            const canvasId = input.context.canvasId;
            if (
              !canvasId ||
              !(await canvases.findById(input.actor.instanceId, canvasId))
            )
              throw new Error("画布已删除");
            return input.context;
          },
        );
        const service = f.host("creation-replay", undefined, (preset) =>
          preset === "design"
            ? { prepare, revalidate: async () => {} }
            : undefined,
        );
        const connection = await f.connect(service);
        const commandId = randomUUID();
        const payload = {
          workspaceId: f.scope.projectId,
          config: {
            modelSelection: { providerId: f.provider.id, modelId: "test" },
          },
          workContext: { preset: "design", canvasId: canvas.id },
        };
        const envelope: protocol.CommandEnvelope = {
          clientId: connection.clientId,
          commandId,
          sessionId: null,
          type: "createSession",
          payload,
          issuedAt: 0,
        };
        const send = (value: protocol.CommandEnvelope = envelope) =>
          service.transportRpc(
            f.actor,
            connection.connectionId,
            "sendConversationCommandV4",
            [{ workspacePath: f.scope.rootDirectory, envelope: value }],
          );
        const original = protocol.commandAckSchema.parse(
          (await send())?.result,
        );
        if (original.result?.type !== "createSession")
          throw new Error("创建未返回真实Task身份");
        const taskId = original.result.sessionId;
        const before = structuredClone(
          await f.repository.find(f.scope.instanceId, taskId),
        );
        expect(await canvases.remove(f.scope.instanceId, canvas.id)).toBe(1);
        f.provider.enabled = false;
        f.provider.configRevision += 1;
        const duplicate = protocol.commandAckSchema.parse(
          (await send())?.result,
        );
        expect(duplicate).toEqual({ ...original, status: "duplicate" });
        await expect(
          send({
            ...envelope,
            payload: {
              ...payload,
              config: {
                modelSelection: {
                  providerId: f.provider.id,
                  modelId: "changed",
                },
              },
            },
          }),
        ).rejects.toMatchObject({ code: "command_conflict" });
        await expect(
          service.transportRpc(
            { ...f.actor, instanceId: randomUUID() },
            connection.connectionId,
            "sendConversationCommandV4",
            [{ workspacePath: f.scope.rootDirectory, envelope }],
          ),
        ).rejects.toThrow();
        await expect(
          f.repository.readCreationCommand(f.scope.instanceId, randomUUID(), {
            clientId: connection.clientId,
            commandId,
            fingerprint: codeUiCommandFingerprint(envelope),
          }),
        ).rejects.toMatchObject({ code: "command_conflict" });
        expect(prepare).toHaveBeenCalledOnce();
        expect(await f.repository.find(f.scope.instanceId, taskId)).toEqual(
          before,
        );
        expect(
          await sql.queryOne(
            "select count(*)::int as count from public.code_ui_commands where instance_id=:instance and client_id=$1 and command_id=$2",
            [connection.clientId, commandId],
          ),
        ).toEqual({ count: 1 });
        expect(
          await sql.queryOne(
            "select count(*)::int as count from public.code_ui_sessions where instance_id=:instance and project_id=$1 and parent_session_id is null",
            [f.scope.projectId],
          ),
        ).toEqual({ count: 2 });
        expect(f.runs).toEqual([]);
      } finally {
        await f.close();
      }
    });
  },
);
