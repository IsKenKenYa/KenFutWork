import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import type { AgentTurnBoundary } from "../agent-runs/types.js";
import {
  type CheckpointRow,
  createCheckpointRepository,
} from "../checkpoints/repository.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
  TaskWorkOutcome,
} from "../task-work/types.js";
import {
  applyMigrations,
  loadMigrationSet,
  type SqlQueryable,
} from "./migrations.js";

const C850_CUTOFF = "20261009120036";
const C850_STOP_REASONS = "20261012011000";
const SCHEMA_BATCH = [
  "20261011160000",
  "20261011180000",
  "20261011190000",
  "20261011200000",
  "20261011210000",
  "20261011220000",
  "20261011230000",
  "20261012010000",
  "20261012030000",
  "20261012050000",
];
type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;

async function createRoot(database: Database) {
  const taskId = randomUUID();
  const threadId = randomUUID();
  const context: TaskWorkContext = {
    ...database.context,
    runId: randomUUID(),
    scope: { ...database.context.scope, taskId },
  };
  const conversation = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: context.scope.rootDirectory,
    config: {
      provider: "zcode",
      model: "schema-fixture",
      thought: "",
      followupMode: "queue",
    },
  });
  await createCodeUiRepository(database.persistence).createRoot(
    database.instanceId,
    {
      sessionId: taskId,
      projectId: context.scope.projectId,
      scope: context.scope,
      createdByClientId: database.actor.accessClientId,
      threadId,
      state: conversation.exportState(),
      command: {
        clientId: "schema-upgrade",
        commandId: randomUUID(),
        fingerprint: randomUUID(),
      },
    },
  );
  await createAgentRunRepository(database.persistence).insert({
    runId: context.runId,
    sessionId: taskId,
    threadId,
    status: "accepted",
  });
  return { context, threadId };
}

async function seedRecords(database: Database, manager: TaskWorkManager) {
  const { context, threadId } = await createRoot(database);
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const execute = vi.fn(() => completion);
  const work = await manager.start(
    context,
    {
      kind: "command",
      detached: true,
      label: "schema lifecycle",
      toolCallId: randomUUID(),
    },
    {
      run: execute,
      stop: async () => {
        finish({ status: "canceled", summary: "fixture stopped" });
      },
    },
  );
  const checkpoint: CheckpointRow = {
    id: randomUUID(),
    instanceId: database.instanceId,
    taskId: context.scope.taskId,
    projectId: context.scope.projectId,
    rootDirectory: context.scope.rootDirectory,
    directorySnapshots: [],
    runId: context.runId,
    kind: "turn",
    label: "schema fixture",
    shadowCommit: "a".repeat(40),
    filesChanged: 1,
    insertions: 3,
    deletions: 0,
    createdAt: new Date().toISOString(),
  };
  await createCheckpointRepository(database.persistence).insert(checkpoint);
  const boundary: AgentTurnBoundary = {
    instanceId: database.instanceId,
    projectId: context.scope.projectId,
    taskId: context.scope.taskId,
    runId: context.runId,
    threadId,
    phase: "pre",
    scopeGeneration: context.scope.generation,
    branchGeneration: context.branchGeneration,
    inputIdentity: {
      clientId: "schema-upgrade",
      sourceCommandId: randomUUID(),
    },
    inputOrigin: "userInput",
    inputMessageId: randomUUID(),
    context: { status: "captured", reference: null },
    files: { status: "captured", reference: checkpoint.id },
  };
  expect(
    await createAgentRunRepository(database.persistence).recordTurnBoundary(
      boundary,
    ),
  ).toBe(true);
  return { context, threadId, work, checkpoint, boundary, execute, finish };
}
type Seed = Awaited<ReturnType<typeof seedRecords>>;

async function readRecords(database: Database, seed: Seed) {
  const { context } = seed;
  return {
    root: await createCodeUiRepository(database.persistence).find(
      database.instanceId,
      context.scope.taskId,
    ),
    work: await createTaskWorkStore(database.persistence).find(
      database.instanceId,
      context.scope.taskId,
      seed.work.id,
    ),
    checkpoint: await createCheckpointRepository(database.persistence).getById(
      database.instanceId,
      seed.checkpoint.id,
    ),
    boundaries: await createAgentRunRepository(
      database.persistence,
    ).getTurnBoundaries({
      instanceId: database.instanceId,
      projectId: context.scope.projectId,
      taskId: context.scope.taskId,
      runId: context.runId,
      threadId: seed.threadId,
    }),
  };
}

async function assertCodeKinds(database: Database, seed: Seed) {
  const sql = database.persistence.forInstance(database.instanceId);
  expect(
    await sql.queryOne(
      "select owner_kind from public.task_works where instance_id=:instance and id=$1",
      [seed.work.id],
    ),
  ).toEqual({ owner_kind: "code" });
  expect(
    await sql.queryOne(
      "select task_kind from public.project_checkpoints where instance_id=:instance and id=$1",
      [seed.checkpoint.id],
    ),
  ).toEqual({ task_kind: "code" });
  expect(
    await sql.queryOne(
      "select task_kind from public.agent_turn_boundaries where instance_id=:instance and run_id=$1 and phase='pre'",
      [seed.context.runId],
    ),
  ).toEqual({ task_kind: "code" });
  expect(
    await sql.queryOne(
      "select task_kind, code_task_id, design_task_id from public.execution_task_owners where instance_id=:instance and task_id=$1",
      [seed.context.scope.taskId],
    ),
  ).toEqual({
    task_kind: "code",
    code_task_id: seed.context.scope.taskId,
    design_task_id: null,
  });
}

/** Actual temporary PG and unmodified Code repositories; no .env or existing database. */
describe.skipIf(process.env.KENFUTWORK_TASK_WORK_PG_TEST !== "1")(
  "c850 Code schema forward compatibility",
  () => {
    it("backfills existing Code data, preserves authority/history, replays no work and keeps old writers valid", async () => {
      const database = await createTaskWorkDatabase({
        stopAtMigration: C850_CUTOFF,
        alsoIncludeMigrations: [C850_STOP_REASONS],
      });
      const manager = createTaskWorkManager({
        store: createTaskWorkStore(database.persistence),
        executionHostId: "schema-upgrade-host",
        resolveMaxConcurrent: async () => 4,
      });
      const client = new Client({
        connectionString: database.connectionString,
      });
      let original: Seed | undefined;
      let fresh: Seed | undefined;
      try {
        await client.connect();
        expect(database.replayed).toContain(C850_STOP_REASONS);
        expect(
          database.replayed.some((version) => SCHEMA_BATCH.includes(version)),
        ).toBe(false);
        expect(
          (
            await client.query(
              "select to_regclass('public.execution_task_owners') as owner_table",
            )
          ).rows,
        ).toEqual([{ owner_table: null }]);
        original = await seedRecords(database, manager);
        const before = await readRecords(database, original);
        expect(before.work?.status).toBe("running");
        const oldRoots = await database.persistence
          .forInstance(database.instanceId)
          .query<{ id: string }>(
            "select id from public.code_ui_sessions where instance_id=:instance and parent_session_id is null order by id",
          );
        const root = fileURLToPath(new URL("../../../../../", import.meta.url));
        const files = loadMigrationSet({
          bootstrapDir: join(root, "supabase/bootstrap"),
          migrationsDir: join(root, "supabase/migrations"),
        }).filter(
          (file) =>
            file.version <= C850_CUTOFF ||
            file.version === C850_STOP_REASONS ||
            SCHEMA_BATCH.includes(file.version),
        );
        const queryable: SqlQueryable = {
          async query<T>(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            return { rowCount: result.rowCount, rows: result.rows as T[] };
          },
        };
        expect((await applyMigrations(queryable, files)).applied).toEqual(
          SCHEMA_BATCH,
        );
        expect(await readRecords(database, original)).toEqual(before);
        expect(original.execute).toHaveBeenCalledOnce();
        await assertCodeKinds(database, original);
        const owners = await database.persistence
          .forInstance(database.instanceId)
          .query<{ task_id: string }>(
            "select task_id from public.execution_task_owners where instance_id=:instance and task_kind='code' order by task_id",
          );
        expect(owners.map((row) => row.task_id)).toEqual(
          oldRoots.map((row) => row.id),
        );
        expect(await applyMigrations(queryable, files)).toEqual({
          applied: [],
          superseded: [],
        });
        expect(await readRecords(database, original)).toEqual(before);
        const previous = original;
        original.finish({
          status: "completed",
          summary: "old executor settled",
        });
        await vi.waitFor(async () =>
          expect(
            (await manager.find(previous.context, previous.work.id))?.status,
          ).toBe("completed"),
        );
        fresh = await seedRecords(database, manager);
        await assertCodeKinds(database, fresh);
        expect(fresh.execute).toHaveBeenCalledOnce();
        const current = fresh;
        fresh.finish({
          status: "completed",
          summary: "post-upgrade executor settled",
        });
        await vi.waitFor(async () =>
          expect(
            (await manager.find(current.context, current.work.id))?.status,
          ).toBe("completed"),
        );
        expect((await readRecords(database, fresh)).boundaries.pre).toEqual(
          fresh.boundary,
        );
        expect((await readRecords(database, fresh)).checkpoint).toEqual(
          fresh.checkpoint,
        );
        expect(original.execute).toHaveBeenCalledOnce();
      } finally {
        original?.finish({ status: "canceled", summary: "cleanup" });
        fresh?.finish({ status: "canceled", summary: "cleanup" });
        await manager.close("schema fixture cleanup");
        await client.end();
        await database.close();
      }
    });
  },
);

// Fresh installation is distinct from the seeded historical upgrade above.
describe.skipIf(process.env.KENFUTWORK_TASK_WORK_PG_TEST !== "1")(
  "fresh schema batch Code compatibility",
  () => {
    it("new schema and its second no-op replay accept the existing Code writers", async () => {
      const database = await createTaskWorkDatabase();
      const manager = createTaskWorkManager({
        store: createTaskWorkStore(database.persistence),
        executionHostId: "fresh-schema-host",
        resolveMaxConcurrent: async () => 4,
      });
      let seeded: Seed | undefined;
      try {
        expect(database.replayed).toEqual(expect.arrayContaining(SCHEMA_BATCH));
        expect(database.secondReplay).toEqual([]);
        seeded = await seedRecords(database, manager);
        await assertCodeKinds(database, seeded);
        expect((await readRecords(database, seeded)).checkpoint).toEqual(
          seeded.checkpoint,
        );
        expect((await readRecords(database, seeded)).boundaries.pre).toEqual(
          seeded.boundary,
        );
        expect(seeded.execute).toHaveBeenCalledOnce();
        const active = seeded;
        seeded.finish({
          status: "completed",
          summary: "fresh Code work settled",
        });
        await vi.waitFor(async () =>
          expect(
            (await manager.find(active.context, active.work.id))?.status,
          ).toBe("completed"),
        );
      } finally {
        seeded?.finish({ status: "canceled", summary: "cleanup" });
        await manager.close("fresh schema cleanup");
        await database.close();
      }
    });
  },
);
