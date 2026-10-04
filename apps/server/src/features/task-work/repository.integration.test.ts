import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { ManagedProcess } from "../process-sandbox/types.js";
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
          context.scope.workspaceId,
          context.scope.taskId,
          foreground.id,
        ),
      ).toMatchObject({ detached: false, consumed: true });
      const output = join(database.directory, "recovery-output.bin");
      await writeFile(output, "preserved");
      await store.updateOutput(
        context.scope.workspaceId,
        context.scope.taskId,
        running.id,
        running.ownerId,
        output,
        { retainedBytes: 9, totalBytes: 9, discardedBytes: 0 },
      );
      await store.settle(
        context.scope.workspaceId,
        context.scope.taskId,
        completed.id,
        { status: "completed", summary: "原终态摘要" },
        "2026-10-02T00:01:00.000Z",
      );
      await store.settle(
        context.scope.workspaceId,
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
          context.scope.workspaceId,
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
              workspaceId: context.scope.workspaceId,
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
