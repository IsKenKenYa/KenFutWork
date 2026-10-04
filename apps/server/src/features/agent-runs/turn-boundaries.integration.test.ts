import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import type { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  BoundaryModel,
  createHarness,
  createSnapshots,
  prepareHarnessTask,
} from "./test-harness.js";

/** 一次性本机集群；不解析.env或连接任何现有数据库。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "Harness持久轮次边界 integration",
  () => {
    it("精确run/phase边界可冷读、同值并发重放幂等，异值和跨owner不能覆盖或读取", async () => {
      const database = await createTaskWorkDatabase();
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        const { scope, actor, threadId, metadata } =
          await prepareHarnessTask(database);
        const service = metadata();
        const runId = randomUUID();
        await service.createAcceptedRun({
          runId,
          sessionId: scope.taskId,
          threadId,
        });
        const pre = {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          taskId: scope.taskId,
          runId,
          threadId,
          phase: "pre" as const,
          scopeGeneration: 1,
          branchGeneration: 1,
          inputIdentity: {
            clientId: "original-client",
            sourceCommandId: "original-command",
          },
          inputOrigin: "userInput" as const,
          inputMessageId: "stable-input-message",
          context: { status: "captured" as const, reference: null },
          files: { status: "captured" as const, reference: null },
        };
        await Promise.all([
          service.recordTurnBoundary(pre),
          service.recordTurnBoundary(pre),
        ]);
        const post = {
          ...pre,
          phase: "post" as const,
          context: { status: "unavailable" as const, reason: "not_supported" },
        };
        await service.recordTurnBoundary(post);
        expect(
          await metadata().getOwnedTurnBoundaries(actor, {
            taskId: scope.taskId,
            runId,
          }),
        ).toEqual({ pre, post });
        await expect(
          service.recordTurnBoundary({
            ...pre,
            inputMessageId: "different-input",
          }),
        ).rejects.toMatchObject({ code: "turn_boundary_conflict" });
        expect(
          await metadata().getOwnedTurnBoundaries(actor, {
            taskId: scope.taskId,
            runId,
          }),
        ).toEqual({ pre, post });
        await expect(
          metadata().getOwnedTurnBoundaries(
            { ...actor, id: randomUUID() },
            { taskId: scope.taskId, runId },
          ),
        ).rejects.toMatchObject({ code: "not_found" });
      } finally {
        await database.close();
      }
    });
    it("真实RunService把原输入native身份与前后context引用写进owned持久账本", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const f = await createHarness(database);
        work = f.work;
        const {
          scope,
          actor,
          threadId,
          metadata,
          handle,
          model,
          service,
          runtime,
        } = f;
        const runId = randomUUID();
        await service.createAcceptedRun({
          runId,
          sessionId: scope.taskId,
          threadId,
        });
        runtime.createRun(
          {
            sessionId: scope.taskId,
            conversationId: scope.taskId,
            taskId: scope.taskId,
            projectId: scope.projectId,
            preset: "code",
            prompt: "真实原输入",
          },
          {
            runId,
            threadId,
            scopeHandle: handle,
            userId: actor.id,
            inputIdentity: {
              clientId: "real-client",
              sourceCommandId: "real-command",
            },
            inputOrigin: "userInput",
          },
        );
        const events: StreamEvent[] = [];
        for await (const event of runtime.streamRun(runId)) events.push(event);
        expect(events.at(-1)?.type).toBe("run.completed");
        const pair = await metadata().getOwnedTurnBoundaries(actor, {
          taskId: scope.taskId,
          runId,
        });
        expect(pair.pre).toMatchObject({
          runId,
          phase: "pre",
          scopeGeneration: 1,
          branchGeneration: 1,
          context: { status: "captured", reference: null },
          files: { status: "unavailable" },
        });
        expect(pair.post).toMatchObject({
          runId,
          phase: "post",
          context: {
            status: "captured",
            reference: { adapter: "deepagents", key: expect.any(String) },
          },
        });
        const input = model.requests
          .at(-1)
          ?.filter(HumanMessage.isInstance)
          .find((message) => message.content === "真实原输入");
        expect(pair.pre?.inputMessageId).toBe(input?.id);
        expect(pair.post?.inputMessageId).toBe(input?.id);
        expect(pair.pre?.inputIdentity).toEqual({
          clientId: "real-client",
          sourceCommandId: "real-command",
        });
      } finally {
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("accepted Run在从未消费stream时被cancelAndWait，仍持久化partial边界并释放活动等待", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const f = await createHarness(database);
        work = f.work;
        const runId = randomUUID();
        await f.service.createAcceptedRun({
          runId,
          sessionId: f.scope.taskId,
          threadId: f.threadId,
        });
        f.runtime.createRun(
          {
            sessionId: f.scope.taskId,
            conversationId: f.scope.taskId,
            taskId: f.scope.taskId,
            projectId: f.scope.projectId,
            preset: "code",
            prompt: "尚未执行",
          },
          {
            runId,
            threadId: f.threadId,
            scopeHandle: f.handle,
            userId: f.actor.id,
            inputIdentity: {
              clientId: "pending-client",
              sourceCommandId: "pending-command",
            },
            inputOrigin: "userInput",
          },
        );
        await f.runtime.cancelRunAndWait(runId);
        expect(f.model.requests).toEqual([]);
        expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
        const pair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        for (const phase of ["pre", "post"] as const)
          expect(pair[phase]).toMatchObject({
            runId,
            phase,
            branchGeneration: null,
            context: { status: "unavailable", reason: "turn_not_started" },
            files: { status: "unavailable", reason: "turn_not_started" },
            inputIdentity: {
              clientId: "pending-client",
              sourceCommandId: "pending-command",
            },
          });
      } finally {
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("重复stream消费者不能提前完成活动Run或为仍在执行的native图写partial post", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let first: Promise<StreamEvent[]> | undefined;
      try {
        const f = await createHarness(
          database,
          new BoundaryModel(async () => {
            started();
            await gate;
          }),
        );
        work = f.work;
        const runId = randomUUID();
        await f.service.createAcceptedRun({
          runId,
          sessionId: f.scope.taskId,
          threadId: f.threadId,
        });
        f.runtime.createRun(
          {
            sessionId: f.scope.taskId,
            conversationId: f.scope.taskId,
            taskId: f.scope.taskId,
            projectId: f.scope.projectId,
            preset: "code",
            prompt: "首消费者正在执行",
          },
          {
            runId,
            threadId: f.threadId,
            scopeHandle: f.handle,
            userId: f.actor.id,
          },
        );
        first = (async () => {
          const events: StreamEvent[] = [];
          for await (const event of f.runtime.streamRun(runId))
            events.push(event);
          return events;
        })();
        await entered;
        const duplicate: StreamEvent[] = [];
        for await (const event of f.runtime.streamRun(runId))
          duplicate.push(event);
        expect(duplicate).toEqual([]);
        expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(true);
        expect(
          (
            await f.metadata().getOwnedTurnBoundaries(f.actor, {
              taskId: f.scope.taskId,
              runId,
            })
          ).post,
        ).toBeNull();
        release();
        expect((await first).at(-1)?.type).toBe("run.completed");
        expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
        expect(
          (
            await f.metadata().getOwnedTurnBoundaries(f.actor, {
              taskId: f.scope.taskId,
              runId,
            })
          ).post,
        ).toMatchObject({ phase: "post", context: { status: "captured" } });
      } finally {
        release();
        await first;
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("真实Git没有文件变化时，两轮pre/post都消费同一effective引用且phase归本run", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        await writeFile(
          join(database.context.scope.rootDirectory, "note.txt"),
          "既存内容\n",
        );
        const snapshots = createSnapshots(database);
        const f = await createHarness(database, undefined, {
          beforeTurn: (input) =>
            snapshots.captureTurnBoundary({ ...input, phase: "pre" }),
          afterTurn: (input) =>
            snapshots.captureTurnBoundary({ ...input, phase: "post" }),
        });
        work = f.work;
        const ids: string[] = [];
        for (const sourceCommandId of ["first-no-change", "second-no-change"]) {
          const runId = randomUUID();
          ids.push(runId);
          await f.service.createAcceptedRun({
            runId,
            sessionId: f.scope.taskId,
            threadId: f.threadId,
          });
          f.runtime.createRun(
            {
              sessionId: f.scope.taskId,
              conversationId: f.scope.taskId,
              taskId: f.scope.taskId,
              projectId: f.scope.projectId,
              preset: "code",
              prompt: sourceCommandId,
            },
            {
              runId,
              threadId: f.threadId,
              scopeHandle: f.handle,
              userId: f.actor.id,
              inputIdentity: { clientId: "no-change-client", sourceCommandId },
              inputOrigin: "userInput",
            },
          );
          const events: StreamEvent[] = [];
          for await (const event of f.runtime.streamRun(runId))
            events.push(event);
          expect(events.at(-1)?.type).toBe("run.completed");
        }
        const actual = await snapshots.list({
          scope: f.handle,
          actor: f.actor,
        });
        expect(actual).toHaveLength(1);
        expect(actual[0]?.runId).toBe(ids[0]);
        for (const runId of ids) {
          const pair = await f
            .metadata()
            .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
          for (const phase of ["pre", "post"] as const)
            expect(pair[phase]).toMatchObject({
              runId,
              phase,
              files: { status: "captured", reference: actual[0]?.id },
            });
        }
      } finally {
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("实际native模型失败仍保存两phase，文件hook失败不能伪装成captured null", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const f = await createHarness(
          database,
          new BoundaryModel(async () => {
            throw new Error("controlled upstream unavailable");
          }),
          {
            beforeTurn: async () => {
              throw new Error("checkpoint system unavailable");
            },
            afterTurn: async () => {
              throw new Error("checkpoint system unavailable");
            },
          },
          true,
        );
        work = f.work;
        const runId = randomUUID();
        await f.service.createAcceptedRun({
          runId,
          sessionId: f.scope.taskId,
          threadId: f.threadId,
        });
        f.runtime.createRun(
          {
            sessionId: f.scope.taskId,
            conversationId: f.scope.taskId,
            taskId: f.scope.taskId,
            projectId: f.scope.projectId,
            preset: "code",
            prompt: "上游失败",
          },
          {
            runId,
            threadId: f.threadId,
            scopeHandle: f.handle,
            userId: f.actor.id,
          },
        );
        const events: StreamEvent[] = [];
        for await (const event of f.runtime.streamRun(runId))
          events.push(event);
        expect(events.at(-1)?.type).toBe("run.failed");
        const pair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        for (const phase of ["pre", "post"] as const)
          expect(pair[phase]).toMatchObject({
            runId,
            phase,
            branchGeneration: 1,
            files: { status: "failed", reason: "capture_failed" },
          });
        expect(pair.pre?.context).toEqual({
          status: "captured",
          reference: null,
        });
        expect(pair.post?.context).toMatchObject({
          status: "captured",
          reference: { adapter: "deepagents", key: expect.any(String) },
        });
        expect(f.model.requests).toHaveLength(1);
        expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
      } finally {
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("实际native LLM在途取消后保存两phase与已提交引用，再释放前台等待", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let draining: Promise<StreamEvent[]> | undefined;
      try {
        const f = await createHarness(
          database,
          new BoundaryModel(async (signal) => {
            entered();
            if (signal?.aborted) return;
            signal?.addEventListener("abort", release, { once: true });
            await gate;
          }),
        );
        work = f.work;
        const runId = randomUUID();
        await f.service.createAcceptedRun({
          runId,
          sessionId: f.scope.taskId,
          threadId: f.threadId,
        });
        f.runtime.createRun(
          {
            sessionId: f.scope.taskId,
            conversationId: f.scope.taskId,
            taskId: f.scope.taskId,
            projectId: f.scope.projectId,
            preset: "code",
            prompt: "正在执行",
          },
          {
            runId,
            threadId: f.threadId,
            scopeHandle: f.handle,
            userId: f.actor.id,
          },
        );
        draining = (async () => {
          const events: StreamEvent[] = [];
          for await (const event of f.runtime.streamRun(runId))
            events.push(event);
          return events;
        })();
        await started;
        await f.runtime.cancelRunAndWait(runId);
        expect((await draining).at(-1)?.type).toBe("run.canceled");
        const pair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        expect(pair.pre).toMatchObject({
          phase: "pre",
          branchGeneration: 1,
          context: { status: "captured", reference: null },
        });
        expect(pair.post).toMatchObject({
          phase: "post",
          branchGeneration: 1,
          context: {
            status: "captured",
            reference: { adapter: "deepagents", key: expect.any(String) },
          },
        });
        expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
      } finally {
        release();
        await draining;
        await work?.close("test cleanup");
        await database.close();
      }
    });
    it("手动compact经真实Harness提交summary，不新增Human或assistant行且ledger为control operation", async () => {
      const database = await createTaskWorkDatabase();
      let work: ReturnType<typeof createTaskWorkManager> | undefined;
      try {
        const f = await createHarness(database);
        work = f.work;
        const saved = await f.persistence.getPersistence();
        if (!saved) throw new Error("手动compact必须共享真实MemorySaver");
        const native = createKenFutWorkDeepAgent({
          env: f.env,
          model: f.model,
          preset: "code",
          systemPrompt: "手动压缩真实历史",
          backendResult: {
            factory: () => f.handle.backend,
            sandboxDir: f.scope.rootDirectory,
            ephemeral: false,
          },
          ...saved,
        });
        const history = Array.from(
          { length: 30 },
          (_, index): BaseMessage =>
            index % 2
              ? new AIMessage(`短AI ${index}`)
              : new HumanMessage({
                  id: `seed-user-${index}`,
                  content: `短用户 ${index}`,
                }),
        );
        for await (const _event of native.streamEvents(
          { messages: history },
          { version: "v2", configurable: { thread_id: f.threadId } },
        )) {
        }
        const before = await native.contextHistory?.captureCurrentReference(
          f.threadId,
        );
        if (!before || !native.contextHistory)
          throw new Error("seed没有真实引用");
        const original = await native.contextHistory.getEffectiveState(before);
        const modelCallsBefore = f.model.requests.length;
        const runId = randomUUID();
        await f.service.createAcceptedRun({
          runId,
          sessionId: f.scope.taskId,
          threadId: f.threadId,
        });
        f.runtime.createRun(
          {
            sessionId: f.scope.taskId,
            conversationId: f.scope.taskId,
            taskId: f.scope.taskId,
            projectId: f.scope.projectId,
            preset: "code",
            prompt: "",
          },
          {
            runId,
            threadId: f.threadId,
            scopeHandle: f.handle,
            userId: f.actor.id,
            operation: { kind: "compact" },
            inputOrigin: "controlOperation",
            inputIdentity: {
              clientId: "compact-client",
              sourceCommandId: "compact-command",
            },
          },
        );
        const events: StreamEvent[] = [];
        for await (const event of f.runtime.streamRun(runId))
          events.push(event);
        expect(events.at(-1)?.type).toBe("run.completed");
        expect(
          events.filter((event) => event.type === "run.compacted"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type.startsWith("message.")),
        ).toEqual([]);
        expect(f.model.requests.length - modelCallsBefore).toBe(1);
        const after = await native.contextHistory.captureCurrentReference(
          f.threadId,
        );
        if (!after) throw new Error("manual操作没有实际持久引用");
        expect(after).not.toEqual(before);
        const compacted = await native.contextHistory.getEffectiveState(after);
        expect(
          compacted.messages.filter((message) => message.summary),
        ).toHaveLength(1);
        expect(compacted.messages.length).toBeLessThan(
          original.messages.length,
        );
        expect(
          (await native.contextHistory.getEffectiveState(before)).messages,
        ).toEqual(original.messages);
        const pair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        for (const phase of ["pre", "post"] as const)
          expect(pair[phase]).toMatchObject({
            runId,
            phase,
            operation: { kind: "compact" },
            inputOrigin: "controlOperation",
            inputMessageId: null,
            inputIdentity: {
              clientId: "compact-client",
              sourceCommandId: "compact-command",
            },
          });
        expect(pair.pre?.context).toEqual({
          status: "captured",
          reference: before,
        });
        expect(pair.post?.context).toEqual({
          status: "captured",
          reference: after,
        });
      } finally {
        await work?.close("test cleanup");
        await database.close();
      }
    });
  },
);
