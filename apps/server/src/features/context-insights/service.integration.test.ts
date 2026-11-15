import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createContextInspectionService } from "./service.js";
import type { ContextRequestStart } from "./types.js";

describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "本机请求检查的真实PG记录",
  () => {
    it("并发同键只创建一次，重建服务可读取，终态幂等且删除后不复活正文", async () => {
      const database = await createTaskWorkDatabase();
      const make = () =>
        createContextInspectionService({
          persistence: database.persistence,
          localInstance: database.localInstance,
          readPageCharacters: async () => 128,
        });
      const request: ContextRequestStart = {
        id: randomUUID(),
        owner: {
          instanceId: database.instanceId,
          taskId: database.context.scope.taskId,
          runId: randomUUID(),
        },
        startedAt: new Date().toISOString(),
        input: {
          model: "actual-model",
          tools: [],
          messages: [
            [{ type: "human", data: { content: "原始输入😀".repeat(100) } }],
          ],
        },
      };
      try {
        expect(database.secondReplay).toHaveLength(0);
        const first = make();
        await Promise.all([
          first.writer.start(request),
          first.writer.start(structuredClone(request)),
        ]);
        await first.writer.start({
          ...request,
          input: {
            messages: request.input.messages,
            tools: [],
            model: "actual-model",
          },
        });
        const cold = make();
        const list = await cold.list(database.actor, {
          taskId: request.owner.taskId,
        });
        expect(list.requests.map((item) => item.id)).toEqual([request.id]);
        expect(list.requests[0]).toMatchObject({
          status: "running",
          httpStatus: null,
          model: "actual-model",
          usage: null,
          outputCharacters: null,
          purpose: "agent",
        });
        await expect(
          first.writer.start({
            ...request,
            input: { ...request.input, model: "different" },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const parts: string[] = [];
        let offset = 0;
        for (;;) {
          const page = await cold.read(database.actor, {
            taskId: request.owner.taskId,
            requestId: request.id,
            part: "input",
            offset,
          });
          expect(page.text.length).toBeLessThanOrEqual(128);
          parts.push(page.text);
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        expect(JSON.parse(parts.join(""))).toEqual(request.input);
        const foreign = { ...database.actor, instanceId: randomUUID() };
        await expect(
          cold.read(foreign, {
            taskId: request.owner.taskId,
            requestId: request.id,
            part: "input",
          }),
        ).rejects.toThrow();
        const finish = {
          id: request.id,
          owner: request.owner,
          endedAt: new Date().toISOString(),
          status: "completed" as const,
          output: [{ content: "真实结果" }],
          usage: { inputTokens: 25, outputTokens: 4 },
        };
        await Promise.all([
          first.writer.finish(finish),
          cold.writer.finish(finish),
        ]);
        expect(
          (await cold.list(database.actor, { taskId: request.owner.taskId }))
            .requests[0],
        ).toMatchObject({ status: "completed", usage: finish.usage });
        await expect(
          first.writer.finish({ ...finish, status: "failed" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const auxiliary = {
          ...request,
          id: randomUUID(),
          purpose: "goal-evaluation" as const,
        };
        await first.writer.start(auxiliary);
        await cold.writer.start(structuredClone(auxiliary));
        expect(
          (
            await cold.list(database.actor, { taskId: request.owner.taskId })
          ).requests.find((row) => row.id === auxiliary.id),
        ).toMatchObject({
          purpose: "goal-evaluation",
          runId: request.owner.runId,
          agentCallId: null,
        });
        await expect(
          cold.writer.start({ ...auxiliary, purpose: "approval-review" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const failure = {
          ...finish,
          id: auxiliary.id,
          status: "failed" as const,
          output: null,
          usage: null,
          httpStatus: 429,
        };
        await Promise.all([
          first.writer.finish(failure),
          cold.writer.finish(failure),
        ]);
        await cold.writer.finish(failure);
        await expect(
          cold.writer.finish({ ...failure, httpStatus: 503 }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (
            await cold.list(database.actor, { taskId: request.owner.taskId })
          ).requests.find((row) => row.id === auxiliary.id),
        ).toMatchObject({ status: "failed", httpStatus: 429 });
        await database.persistence
          .forInstance(database.instanceId)
          .execute(
            "update public.code_ui_sessions set deleted_at=now() where instance_id=:instance and id=$1",
            [request.owner.taskId],
          );
        await first.writer.finish(finish);
        await first.writer.finish(failure);
        await expect(first.writer.start(request)).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(
          cold.read(database.actor, {
            taskId: request.owner.taskId,
            requestId: request.id,
            part: "input",
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const stored = await database.persistence.queryOne<{ count: string }>(
          "select count(*)::text as count from public.context_model_requests where id in ($1, $2)",
          [request.id, auxiliary.id],
        );
        expect(stored?.count).toBe("0");
      } finally {
        await database.close();
      }
    });
  },
);
