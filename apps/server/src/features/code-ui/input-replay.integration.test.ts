import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCanvasRepository } from "../canvas/repository.js";
import { createGoalServiceFixture } from "./goal-service.fixture.js";
import type { ConversationWorkContextProvider } from "./work-context.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "原RPC输入重放真实PG receipt",
  () => {
    it("删除选区/画布及模型停用后同命令返回原ACK，不重新准备；篡改payload与其他实例不能借重放", async () => {
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
          name: "输入引用",
        });
        if (!canvas) throw new Error("真实文档未创建");
        let selectionLive = true;
        const prepare = vi.fn(
          async (
            input: Parameters<ConversationWorkContextProvider["prepare"]>[0],
          ) => {
            if (
              !selectionLive ||
              !(await canvases.findById(
                input.actor.instanceId,
                input.context.canvasId!,
              ))
            )
              throw new Error("引用已删除");
            return input.context;
          },
        );
        const provider: ConversationWorkContextProvider = {
          prepare,
          revalidate: async () => {},
        };
        const capture = vi.fn((preset: "code" | "design") => ({
          version: 1 as const,
          preset,
          entries: [],
        }));
        const service = f.host("verified-replay", capture, (preset) =>
          preset === "design" ? provider : undefined,
        );
        const command = await f.connect(service);
        const commandId = randomUUID();
        const payload = {
          text: "继续设计",
          workContext: {
            preset: "design",
            canvasId: canvas.id,
            selectedCanvasElements: [{ id: "selected" }],
          },
        };
        const admitted = await command("sendText", payload, commandId);
        await f.waitRuns(1);
        expect(admitted.result).toMatchObject({ status: "accepted" });
        const before = structuredClone(
          (await f.repository.find(f.scope.instanceId, f.scope.taskId))!.state,
        );
        const counts = {
          prepare: prepare.mock.calls.length,
          capture: capture.mock.calls.length,
        };
        selectionLive = false;
        f.provider.enabled = false;
        const selectionReplay = await command("sendText", payload, commandId);
        await selectionReplay.settled;
        expect(selectionReplay.result).toEqual({
          ...protocol.commandAckSchema.parse(admitted.result),
          status: "duplicate",
        });
        expect(await canvases.remove(f.scope.instanceId, canvas.id)).toBe(1);
        const documentReplay = await command("sendText", payload, commandId);
        await documentReplay.settled;
        expect(documentReplay.result).toEqual({
          ...protocol.commandAckSchema.parse(admitted.result),
          status: "duplicate",
        });
        await expect(
          command("sendText", { ...payload, text: "不同输入" }, commandId),
        ).rejects.toMatchObject({ code: "command_conflict" });
        await expect(
          service.transportRpc(
            { ...f.actor, instanceId: randomUUID() },
            command.connectionId,
            "sendConversationCommandV4",
            [
              {
                workspacePath: f.scope.rootDirectory,
                envelope: {
                  clientId: "foreign",
                  commandId,
                  sessionId: f.scope.taskId,
                  type: "sendText",
                  payload,
                  issuedAt: 0,
                },
              },
            ],
          ),
        ).rejects.toThrow();
        expect(prepare).toHaveBeenCalledTimes(counts.prepare);
        expect(capture).toHaveBeenCalledTimes(counts.capture);
        expect(f.runs).toHaveLength(1);
        expect(
          (await f.repository.find(f.scope.instanceId, f.scope.taskId))!.state,
        ).toEqual(before);
      } finally {
        await f.close();
      }
    });

    it("并发副本资源准备失败时返回已提交副本的核验ACK，仅一条输入和一次执行", async () => {
      const f = await createGoalServiceFixture();
      let allowFirst!: () => void;
      const bothPreparing = new Promise<void>((resolve) => {
        allowFirst = resolve;
      });
      let releaseSecond!: () => void;
      const committed = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const pending: Promise<unknown>[] = [];
      try {
        await f.database.persistence
          .forInstance(f.scope.instanceId)
          .execute(
            "update public.projects set enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
            [f.scope.projectId],
          );
        const canvases = createCanvasRepository(f.database.persistence);
        const canvas = await canvases.create({
          instanceId: f.scope.instanceId,
          projectId: f.scope.projectId,
          canvasId: randomUUID(),
          name: "并发引用",
        });
        if (!canvas) throw new Error("真实文档未创建");
        let preparations = 0;
        const provider: ConversationWorkContextProvider = {
          revalidate: async () => {},
          prepare: async ({ context }) => {
            preparations += 1;
            if (preparations === 1) {
              await bothPreparing;
              return context;
            }
            allowFirst();
            await committed;
            if (
              !(await canvases.findById(f.scope.instanceId, context.canvasId!))
            )
              throw new Error("准备中的文档已删除");
            return context;
          },
        };
        const service = f.host("concurrent-replay", undefined, (preset) =>
          preset === "design" ? provider : undefined,
        );
        const command = await f.connect(service);
        const commandId = randomUUID();
        const payload = {
          text: "并发输入",
          workContext: { preset: "design", canvasId: canvas.id },
        };
        const first = command("sendText", payload, commandId);
        const second = command("sendText", payload, commandId);
        pending.push(first, second);
        for (const request of pending) void request.catch(() => {});
        const accepted = await first;
        await f.waitRuns(1);
        expect(await canvases.remove(f.scope.instanceId, canvas.id)).toBe(1);
        releaseSecond();
        const duplicate = await second;
        await duplicate.settled;
        expect(duplicate.result).toEqual({
          ...protocol.commandAckSchema.parse(accepted.result),
          status: "duplicate",
        });
        expect(f.runs).toHaveLength(1);
        expect(
          (
            await f.repository.find(f.scope.instanceId, f.scope.taskId)
          )?.state?.inputs?.filter(
            (input) => input.intent.sourceCommandId === commandId,
          ),
        ).toHaveLength(1);
      } finally {
        allowFirst();
        releaseSecond();
        await Promise.allSettled(pending);
        await f.close();
      }
    });
  },
);
