import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createGoalService } from "../goals/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  applyMigrations,
  loadMigrationSet,
  type SqlQueryable,
} from "./migrations.js";

const CUTOFF = "20261020104000";
type MigrationDatabase = Awaited<ReturnType<typeof createTaskWorkDatabase>>;
type LegacyGoalStatus = "active" | "paused";

function createClaimedGoal(runId: string, status: LegacyGoalStatus) {
  const service = createGoalService();
  const created = service.create(null, {
    goalId: randomUUID(),
    objective: "检查项目文件",
    branchGeneration: 1,
    tokenBudget: null,
    at: Date.now(),
  });
  const claimed = service.claimRun(created, {
    goalId: created.goalId,
    revision: created.revision,
    runId,
    at: Date.now(),
    foreground: {
      branchGeneration: 1,
      taskReady: true,
      activeRunId: null,
      userReserved: false,
      userQueued: false,
      approvalWaiting: false,
    },
  });
  return status === "active"
    ? claimed
    : service.pause(claimed, {
        goalId: claimed.goalId,
        revision: claimed.revision,
        reason: "goal.userPaused",
        at: Date.now(),
      });
}

function createLegacyState(
  database: MigrationDatabase,
  goalStatus: LegacyGoalStatus,
) {
  const taskId = database.context.scope.taskId;
  const runId = randomUUID();
  const commandId = randomUUID();
  const host = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: database.context.scope.rootDirectory,
    config: {
      provider: "zcode",
      model: "configured-model",
      thought: "",
      followupMode: "queue",
      mode: "build",
      planEnabled: true,
    },
  });
  host.startTurn({
    runId,
    commandId,
    text: "读取项目文件",
    mode: "build",
    planEnabled: true,
  });
  const goal = createClaimedGoal(runId, goalStatus);
  expect(goal.status).toBe(goalStatus);
  expect(goal.claimedRunId).toBe(runId);
  expect(goal.runStartedAt).not.toBeNull();
  host.setGoal(goal);
  const invocation = {
    providerId: randomUUID(),
    modelId: "configured-model",
    configRevision: 9,
    body: {},
    inputCapabilities: { image: false, pdf: false },
  };
  const records = ["active", "queued", "reserved", "settled", "discarded"].map(
    (status, index) => ({
      executionMode: "solo",
      status,
      runId: index === 0 ? runId : randomUUID(),
      intent: {
        clientId: "upgrade-client",
        sourceCommandId: index === 0 ? commandId : randomUUID(),
        queueItemId: randomUUID(),
        text: "历史输入",
        mode: "build",
        planEnabled: true,
      },
      modelInvocation: invocation,
      scopeGeneration: 1,
      branchGeneration: 1,
    }),
  );
  const state = {
    ...host.exportState(),
    inputs: records,
    runExecutionModes: [[runId, "solo"]],
    inheritedHistory: [
      {
        canonical: {
          executionMode: "plan",
          modelInvocation: invocation,
          intent: { text: "历史来源", mode: "build", planEnabled: true },
        },
      },
    ],
  };
  return {
    taskId,
    runId,
    threadId: randomUUID(),
    commandId,
    invocation,
    records,
    state,
    snapshot: state.snapshots[0]!,
  };
}

type LegacyState = ReturnType<typeof createLegacyState>;

async function seedLegacyState(
  database: MigrationDatabase,
  client: Client,
  source: LegacyState,
) {
  const { taskId, runId, threadId, commandId, records, state, snapshot } =
    source;
  // 升级测试写入历史数据形态，不启动模型或任务执行器。
  const legacySnapshot = {
    ...snapshot,
    queue: {
      autoDrain: true,
      items: records
        .filter((entry) => entry.status === "queued")
        .map((entry) => entry.intent),
    },
    pendingCommands: records
      .filter((entry) => entry.status === "reserved")
      .map((entry) => ({
        commandId: entry.intent.sourceCommandId,
        clientId: entry.intent.clientId,
        type: "sendText",
        state: "executing",
        at: Date.now(),
      })),
  };
  const sql = database.persistence.forInstance(database.instanceId);
  await sql.execute(
    "update public.code_ui_sessions set state=$2::jsonb, active_run_id=$3 where instance_id=:instance and id=$1",
    [taskId, JSON.stringify({ ...state, snapshots: [legacySnapshot] }), runId],
  );
  await sql.execute(
    "insert into public.chat_sessions (id,instance_id,project_id,mode,thread_id) values ($1,:instance,$2,'code',$3)",
    [taskId, database.context.scope.projectId, threadId],
  );
  await client.query(
    "insert into public.agent_runs (id,session_id,thread_id,status) values ($1,$2,$3,'running')",
    [runId, taskId, threadId],
  );
  await sql.execute(
    "insert into public.code_ui_commands (instance_id,client_id,command_id,session_id,parameter_fingerprint,ack,status) values (:instance,'upgrade-client',$1,$2,'old-fingerprint',$3::jsonb,'accepted')",
    [commandId, taskId, JSON.stringify({ commandId, status: "accepted" })],
  );
}

function migrationContext(client: Client) {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const files = loadMigrationSet({
    bootstrapDir: join(root, "supabase/bootstrap"),
    migrationsDir: join(root, "supabase/migrations"),
  });
  const queryable: SqlQueryable = {
    async query<T>(text: string, values?: unknown[]) {
      const result = await client.query(text, values);
      return { rowCount: result.rowCount, rows: result.rows as T[] };
    },
  };
  return { files, queryable };
}

async function assertMigratedTask(
  database: MigrationDatabase,
  source: LegacyState,
) {
  const after = await createCodeUiRepository(database.persistence).find(
    database.instanceId,
    source.taskId,
  );
  expect(after?.active_run_id).toBeNull();
  expect(after?.root_directory).toBe(database.context.scope.rootDirectory);
  expect(after?.scope_generation).toBe("1");
  expect(after?.state?.runApprovalCeilings).toEqual(
    source.state.runApprovalCeilings,
  );
  expect(after?.state?.inputs?.map((entry) => entry.status)).toEqual([
    "discarded",
    "discarded",
    "discarded",
    "settled",
    "discarded",
  ]);
  expect(after?.state?.inputs?.map((entry) => entry.modelInvocation)).toEqual(
    source.records.map(() => source.invocation),
  );
  expect(after?.state?.goalRecord).toMatchObject({
    status: "paused",
    claimedRunId: null,
    runStartedAt: null,
    lastSettledRunId: source.runId,
  });
  expect(after?.state?.snapshots[0]?.config).toEqual(source.snapshot.config);
  expect(after?.state?.snapshots[0]?.queue).toMatchObject({
    items: [],
    autoDrain: false,
  });
  expect(after?.state?.snapshots[0]?.control).toMatchObject({
    phase: "completedInterrupted",
    activeWorks: [],
    canStop: false,
    lastError: {
      code: "agent_workflow_updated",
      message: "工作流程已更新 请重新提交未完成输入",
    },
  });
  expect(after?.state?.snapshots[0]?.pendingCommands).toEqual([]);
  expect(after?.state).not.toHaveProperty("runExecutionModes");
  for (const entry of after?.state?.inputs ?? [])
    expect(entry).not.toHaveProperty("executionMode");
  expect(after?.state?.inheritedHistory?.[0]?.canonical).not.toHaveProperty(
    "executionMode",
  );
  return after;
}

async function assertRunAndCommandHistory(
  database: MigrationDatabase,
  client: Client,
  source: LegacyState,
) {
  const { taskId, runId, commandId } = source;
  expect(
    (
      await client.query(
        "select status, stop_reason from public.agent_runs where id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([{ status: "canceled", stop_reason: "host_shutdown" }]);
  expect(
    (
      await client.query(
        "select parameter_fingerprint from public.code_ui_commands where command_id=$1",
        [commandId],
      )
    ).rows,
  ).toEqual([{ parameter_fingerprint: "old-fingerprint" }]);
  await expect(
    createCodeUiRepository(database.persistence).applyCommand(
      database.instanceId,
      {
        clientId: "upgrade-client",
        commandId,
        sessionId: taskId,
        type: "sendText",
        payload: { text: "新的统一输入" },
        issuedAt: Date.now(),
      },
      "new-fingerprint",
      () => {
        throw new Error("旧命令不可再次执行");
      },
    ),
  ).rejects.toMatchObject({ code: "command_conflict" });
}

describe.skipIf(process.env.KENFUTWORK_TASK_WORK_PG_TEST !== "1")(
  "统一 Agent 前向迁移 integration",
  () => {
    it.each(["active", "paused"] as const)(
      "Goal原状态%s且Run未结束时清理旧输入并保留授权和命令指纹",
      async (goalStatus) => {
        const database = await createTaskWorkDatabase({
          stopAtMigration: CUTOFF,
        });
        const client = new Client({
          connectionString: database.connectionString,
        });
        try {
          await client.connect();
          const source = createLegacyState(database, goalStatus);
          await seedLegacyState(database, client, source);
          const { files, queryable } = migrationContext(client);
          expect(
            (await applyMigrations(queryable, files)).applied.length,
          ).toBeGreaterThan(0);
          expect(
            (
              await client.query(
                "select column_name from information_schema.columns where table_schema='public' and table_name='chat_sessions' and column_name='execution_mode'",
              )
            ).rows,
          ).toEqual([]);
          const after = await assertMigratedTask(database, source);
          await assertRunAndCommandHistory(database, client, source);
          expect(await applyMigrations(queryable, files)).toEqual({
            applied: [],
            superseded: [],
          });
          expect(
            await createCodeUiRepository(database.persistence).find(
              database.instanceId,
              source.taskId,
            ),
          ).toEqual(after);
        } finally {
          await client.end();
          await database.close();
        }
      },
      90_000,
    );
  },
);
