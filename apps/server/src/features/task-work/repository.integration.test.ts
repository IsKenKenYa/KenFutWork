import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { ManagedProcess } from "../process-sandbox/types.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkStore } from "./repository.js";
import { createTaskWorkManager } from "./service.js";
import { createTaskWorkDatabase } from "./test-postgres-schema.js";
import type {
  TaskWorkHostLoss,
  TaskWorkOutcome,
  TaskWorkRecord,
} from "./types.js";

/** 默认跳过；显式运行仅使用全新私有PG，实际Schema来自canonical migrations。 */
describe.skipIf(process.env.KENFUTWORK_TASK_WORK_PG_TEST !== "1")(
  "TaskWork生产repository真实PG seam",
  () => {
    let database: Awaited<ReturnType<typeof createTaskWorkDatabase>>;
    beforeAll(async () => {
      database = await createTaskWorkDatabase();
    });
    afterAll(async () => {
      await database?.close();
    });

    it("Design-only项目的冻结Design Run使用唯一Code owner；旧Design身份不能新派发或消费", async () => {
      const rootDirectory = join(
        database.directory,
        `design-task-${randomUUID()}`,
      );
      await mkdir(rootDirectory);
      const { project } = await createProjectRepository(
        database.persistence,
      ).createProject({
        instanceId: database.instanceId,
        createdByClientId: database.actor.accessClientId,
        kind: "design",
        name: "共享Design Task",
        slug: randomUUID(),
        description: null,
        canvasName: "unused",
        workDir: rootDirectory,
      });
      const taskId = randomUUID();
      const scope = {
        ...database.context.scope,
        taskId,
        projectId: project.id,
        rootDirectory,
      };
      const context = {
        ...database.context,
        scope,
        ownerKind: "code" as const,
        runId: "canonical-design-run",
      };
      const host = createCodeUiConversation({
        sessionId: taskId,
        workspacePath: rootDirectory,
        config: {
          provider: "fixture",
          model: "fixture",
          thought: "",
          followupMode: "queue",
        },
        workContext: { preset: "design" },
      });
      host.startTurn({
        runId: context.runId,
        commandId: randomUUID(),
        text: "处理设计文件",
        workContext: { preset: "design" },
      });
      await createCodeUiRepository(database.persistence).createRoot(
        database.instanceId,
        {
          sessionId: taskId,
          projectId: project.id,
          scope,
          createdByClientId: database.actor.accessClientId,
          threadId: randomUUID(),
          state: host.exportState(),
          command: {
            clientId: "fixture",
            commandId: randomUUID(),
            fingerprint: randomUUID(),
          },
        },
      );
      const store = createTaskWorkStore(database.persistence);
      const manager = createTaskWorkManager({
        store,
        executionHostId: `shared-design-${taskId}`,
        resolveMaxConcurrent: async () => 4,
      });
      const legacy = { ...context, ownerKind: "design" as const };
      const runner = vi.fn(
        async (): Promise<TaskWorkOutcome> => ({
          status: "completed",
          summary: "共享Task结果",
        }),
      );
      try {
        expect(await store.isCurrent(context)).toBe(true);
        expect(await store.isCurrent(legacy)).toBe(false);
        expect(
          await store.closeFence(database.instanceId, taskId, "design"),
        ).toBeNull();
        await expect(
          manager.start(
            legacy,
            {
              kind: "command",
              label: "退役执行",
              toolCallId: "legacy-dispatch",
            },
            { run: runner, stop: async () => {} },
          ),
        ).rejects.toMatchObject({ code: "task_closed" });
        expect(runner).not.toHaveBeenCalled();
        const legacyRecord: TaskWorkRecord = {
          id: randomUUID(),
          scope,
          ownerKind: "design",
          agentId: "main",
          kind: "command",
          detached: true,
          label: "退役记录",
          originRunId: context.runId,
          toolCallId: "legacy-create",
          parameterFingerprint: "legacy",
          branchGeneration: 1,
          status: "running",
          startedAt: new Date().toISOString(),
          consumed: false,
          ownerId: randomUUID(),
          executionHostId: "legacy-host",
        };
        await expect(store.create(legacyRecord)).rejects.toMatchObject({
          code: "task_closed",
        });
        expect(await store.list(database.instanceId, taskId)).toEqual([]);
        const record = await manager.start(
          context,
          {
            kind: "command",
            detached: true,
            label: "Design工作",
            toolCallId: "canonical-dispatch",
          },
          { run: runner, stop: async () => {} },
        );
        await vi.waitFor(async () =>
          expect((await manager.find(context, record.id))?.status).toBe(
            "completed",
          ),
        );
        expect(
          await store.find(database.instanceId, taskId, record.id),
        ).toMatchObject({ ownerKind: "code", originRunId: context.runId });
        expect(await store.consume(legacy)).toEqual([]);
        expect(await store.consume(context)).toMatchObject([
          { id: record.id, ownerKind: "code", consumed: true },
        ]);
        expect(
          await database.persistence
            .forInstance(database.instanceId)
            .queryOne(
              "select task_kind,code_task_id,design_task_id from public.execution_task_owners where instance_id=:instance and task_id=$1",
              [taskId],
            ),
        ).toEqual({
          task_kind: "code",
          code_task_id: taskId,
          design_task_id: null,
        });
      } finally {
        await manager.close("cleanup");
      }
    });

    it("日志先采集再终态，缺少outcome引用也保留真实输出与统计；全迁移重放后no-op", async () => {
      expect(database.replayed).toHaveLength(database.expectedMigrations);
      expect(database.secondReplay).toEqual([]);
      const { context, persistence } = database;
      const manager = createTaskWorkManager({
        store: createTaskWorkStore(persistence),
        executionHostId: "repository-output-host",
        resolveMaxConcurrent: async () => 4,
      });
      const output = join(database.directory, "captured-output.bin");
      await writeFile(output, "old output\n");
      let finish!: (outcome: TaskWorkOutcome) => void;
      const completion = new Promise<TaskWorkOutcome>((resolve) => {
        finish = resolve;
      });
      try {
        const record = await manager.start(
          context,
          {
            kind: "command",
            label: "真实持久日志",
            toolCallId: "persistent-output",
          },
          {
            run: () => completion,
            stop: async () => {
              finish({ status: "canceled", summary: "confirmed" });
            },
          },
        );
        await manager.recordOutput(context, record.id, output, {
          retainedBytes: 11,
          totalBytes: 15,
          discardedBytes: 4,
        });
        finish({ status: "failed", summary: "执行器终态未带输出字段" });
        await vi.waitFor(async () =>
          expect((await manager.find(context, record.id))?.status).toBe(
            "failed",
          ),
        );
        expect(await manager.find(context, record.id)).toMatchObject({
          status: "failed",
          outputRef: output,
          outputStats: { retainedBytes: 11, totalBytes: 15, discardedBytes: 4 },
        });
        expect(await readFile(output, "utf8")).toBe("old output\n");
        await manager.consumeNotifications(context);
      } finally {
        await manager.close("cleanup");
      }
    });
    it("真实恢复SQL保留terminal原状态并抑制旧通知，foreground记录从创建起不mailbox", async () => {
      const { context, persistence } = database;
      const store = createTaskWorkStore(persistence);
      const makeRecord = (detached: boolean): TaskWorkRecord => ({
        id: randomUUID(),
        scope: context.scope,
        agentId: "worker",
        kind: "subagent",
        detached,
        label: "旧子任务",
        originRunId: "previous-api-run",
        toolCallId: randomUUID(),
        parameterFingerprint: "stored-old-params",
        branchGeneration: 1,
        status: "running",
        startedAt: "2026-10-02T00:00:00.000Z",
        consumed: !detached,
        ownerId: "00000000-0000-4000-8000-000000000040",
        executionHostId: "recovery-sql-host",
      });
      const running = makeRecord(true);
      const completed = makeRecord(true);
      const foreground = makeRecord(false);
      await store.create(running);
      await store.create(completed);
      await store.create(foreground);
      expect(
        await store.find(
          context.scope.instanceId,
          context.scope.taskId,
          foreground.id,
        ),
      ).toMatchObject({ detached: false, consumed: true });
      const output = join(database.directory, "recovery-output.bin");
      await writeFile(output, "preserved");
      await store.updateOutput(
        context.scope.instanceId,
        context.scope.taskId,
        running.id,
        running.ownerId,
        output,
        { retainedBytes: 9, totalBytes: 9, discardedBytes: 0 },
      );
      await store.settle(
        context.scope.instanceId,
        context.scope.taskId,
        completed.id,
        { status: "completed", summary: "原终态摘要" },
        "2026-10-02T00:01:00.000Z",
      );
      await store.settle(
        context.scope.instanceId,
        context.scope.taskId,
        foreground.id,
        { status: "completed", summary: "原SDK返回" },
        "2026-10-02T00:01:00.000Z",
      );
      const manager = createTaskWorkManager({
        store,
        executionHostId: "recovery-sql-host",
        resolveMaxConcurrent: async () => 4,
      });
      const changed: string[] = [];
      manager.onChanged(async (record) => {
        changed.push(record.id);
      });
      const ready = vi.fn(async () => true);
      manager.onReady(ready);
      try {
        expect(
          (await manager.initialize()).map((record) => record.id).sort(),
        ).toEqual([running.id, completed.id].sort());
        expect(changed.sort()).toEqual([running.id, completed.id].sort());
        expect(await manager.find(context, running.id)).toMatchObject({
          status: "interrupted",
          consumed: true,
          outputRef: output,
          outputStats: { retainedBytes: 9, totalBytes: 9, discardedBytes: 0 },
        });
        expect(await manager.find(context, completed.id)).toMatchObject({
          status: "completed",
          consumed: true,
          endedAt: "2026-10-02T00:01:00.000Z",
          summary: "原终态摘要",
        });
        expect(
          await manager.consumeNotifications({
            ...context,
            runId: "new-api-run",
          }),
        ).toEqual([]);
        await manager.notifyReady(
          context.scope.instanceId,
          context.scope.taskId,
        );
        expect(ready).not.toHaveBeenCalled();
        expect(await readFile(output, "utf8")).toBe("preserved");
      } finally {
        await manager.close("cleanup");
      }
    });

    it("真实PG会话丢失立即拒绝新派发，发布宿主丢失事件并等待旧命令真实退出", async () => {
      const { context, persistence } = database;
      const sandbox = createProcessSandbox({
        captureRoot: join(database.directory, "loss-capture"),
        network: { allowedDomains: [], deniedDomains: [] },
      });
      const losses: TaskWorkHostLoss[] = [];
      const failures: unknown[] = [];
      const manager = createTaskWorkManager({
        store: createTaskWorkStore(persistence),
        executionHostId: "physical-loss-host",
        resolveMaxConcurrent: async () => 4,
        onError: (error) => {
          failures.push(error);
        },
      });
      manager.onHostLost(async (event) => {
        losses.push(event);
      });
      let spawned!: (child: ManagedProcess) => void;
      const childReady = new Promise<ManagedProcess>((resolve) => {
        spawned = resolve;
      });
      let stopCalls = 0;
      try {
        await manager.start(
          context,
          {
            kind: "command",
            label: "真实失锁停止",
            toolCallId: "physical-loss",
          },
          {
            async run() {
              const child = await sandbox.spawn({
                scope: context.scope,
                agentId: "worker",
                invocationId: "pg-loss-process",
                argv: {
                  executable: process.execPath,
                  args: [
                    "-e",
                    'process.stdout.write("alive");setInterval(()=>{},1000)',
                  ],
                },
                background: true,
                timeoutMs: null,
                limits: {
                  maxOutputBytes: 65536,
                  previewMaxChars: 8000,
                  yieldMs: 20,
                  killGraceMs: 2000,
                },
              });
              spawned(child);
              const exit = await child.waitForExit();
              return {
                status: exit.stopped ? "canceled" : "completed",
                summary: "真实管理范围已退出",
              };
            },
            async stop(reason) {
              stopCalls++;
              expect((await (await childReady).stop(reason)).rangeEmpty).toBe(
                true,
              );
            },
          },
        );
        const child = await childReady;
        await expect
          .poll(
            async () =>
              (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
          )
          .toContain("alive");
        await database.stop();
        await vi.waitFor(() => expect(losses).toHaveLength(1));
        expect(losses[0]).toMatchObject({
          executionHostId: "physical-loss-host",
          tasks: [
            {
              instanceId: context.scope.instanceId,
              taskId: context.scope.taskId,
            },
          ],
        });
        await expect(
          manager.start(
            context,
            { kind: "command", label: "失锁后迟到", toolCallId: "after-loss" },
            {
              run: async () => ({
                status: "completed",
                summary: "must-not-run",
              }),
              stop: async () => {},
            },
          ),
        ).rejects.toMatchObject({ code: "task_closed" });
        expect(await child.waitForExit()).toMatchObject({
          stopped: true,
          rangeEmpty: true,
        });
        expect(stopCalls).toBe(1);
        await vi.waitFor(() => expect(failures.length).toBeGreaterThan(0));
      } finally {
        await Promise.allSettled([
          manager.close("cleanup"),
          sandbox.close("cleanup"),
        ]);
      }
    });
  },
);
