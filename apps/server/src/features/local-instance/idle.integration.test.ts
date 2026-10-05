import { randomUUID } from "node:crypto";
import {
  AGENT_GOVERNANCE_LIMITS,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type CodeUiConversationState,
  createCodeUiConversation,
} from "../code-ui/conversation.js";
import type { CodeAdmittedInput } from "../code-ui/input-intents.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { waitForLocalInstanceIdle } from "./idle.js";

type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;

function makeState(
  database: Database,
  status: "queued" | "reserved",
  autoDrain: boolean,
  childAutoDrain?: boolean,
) {
  const host = createCodeUiConversation({
    sessionId: database.context.scope.taskId,
    workspacePath: database.context.scope.rootDirectory,
    config: {
      provider: "zcode",
      model: "idle-regression-model",
      thought: "",
      followupMode: "queue",
    },
  });
  const runId = randomUUID();
  const providerId = randomUUID();
  const record: CodeAdmittedInput = {
    intent: protocol.conversationInputIntentSchema.parse({
      sourceCommandId: randomUUID(),
      queueItemId: randomUUID(),
      clientId: "idle-regression-client",
      kind: "sendText",
      text: "迁移后保留此输入，不自动重放",
      attachments: [],
      modelSelection: {
        providerId,
        modelId: "idle-regression-model",
        options: {},
      },
      mode: "build",
      planEnabled: false,
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 1, queuePosition: 0 },
      steer: { state: "notRequested" },
      dispatch: { state: status, reservationId: runId },
      admittedAt: Date.now(),
    }),
    runId,
    modelInvocation: {
      providerId,
      modelId: "idle-regression-model",
      configRevision: 1,
      body: {},
      inputCapabilities: { image: false, pdf: false },
    },
    scopeGeneration: database.context.scope.generation,
    branchGeneration: database.context.branchGeneration,
    status,
  };
  host.admitInput(record);
  const childId = randomUUID();
  if (childAutoDrain !== undefined)
    host.registerChildDispatch({
      parentSessionId: database.context.scope.taskId,
      parentRunId: randomUUID(),
      toolCallId: randomUUID(),
      childSessionId: childId,
      role: "explore",
      title: "子快照不能决定根Task队列是否等待",
      at: Date.now(),
    });
  const state = host.exportState();
  for (const snapshot of state.snapshots) {
    snapshot.queue.autoDrain =
      snapshot.sessionId === database.context.scope.taskId
        ? autoDrain
        : (childAutoDrain ?? false);
  }
  // 持久数组顺序不代表根身份；idle必须通过sessionId关联真实根row。
  state.snapshots.reverse();
  return { state, record };
}

/** 默认跳过；复用独占临时PG与canonical迁移，绝不连接开发库。 */
describe.skipIf(process.env.KENFUTWORK_LOCAL_ROOT_PG_TEST !== "1")(
  "本地实例迁移等待的真实持久队列边界",
  () => {
    let database: Database;
    let settings: ReturnType<typeof createSettingsService>;
    let waiters: Promise<void>[];

    async function persist(
      state: CodeUiConversationState,
      activeRunId: string | null = null,
    ) {
      const repository = createCodeUiRepository(database.persistence);
      const root = await repository.find(
        database.instanceId,
        database.context.scope.taskId,
      );
      if (!root) throw new Error("独占PG夹具缺少根Task。");
      await repository.save(
        database.instanceId,
        root.id,
        Number(root.revision),
        state,
        activeRunId,
      );
    }

    function beginWait() {
      let reportBlocked!: () => void;
      let finished = false;
      const blocked = new Promise<void>((resolve) => {
        reportBlocked = resolve;
      });
      const readSettings = settings.getInstanceSettings.bind(settings);
      const polls = vi
        .spyOn(settings, "getInstanceSettings")
        .mockImplementation(async (actor, instanceId) => {
          const value = await readSettings(actor, instanceId);
          reportBlocked();
          return value;
        });
      const done = database.localInstance
        .beginMaintenance(() =>
          waitForLocalInstanceIdle({
            instance: database.localInstance,
            persistence: database.persistence,
            settings,
            // 本夹具没有进程内Run/Job；在途身份与队列均从真实PG读取。
            runs: { activeRunCount: () => 0 },
            inFlightJobs: () => 0,
          }),
        )
        .then(() => {
          finished = true;
        });
      waiters.push(done);
      return { done, blocked, polls, finished: () => finished };
    }

    beforeAll(async () => {
      database = await createTaskWorkDatabase();
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      waiters = [];
      settings = createSettingsService({
        repository: createSettingsRepository(database.persistence),
        localInstance: database.localInstance,
      });
      await settings.updateInstanceSettings(
        database.actor,
        database.instanceId,
        {
          localDataMigrationPollMs:
            AGENT_GOVERNANCE_LIMITS.localDataMigrationPollMs.min,
        },
      );
      await database.persistence
        .forInstance(database.instanceId)
        .execute(
          "update public.code_ui_sessions set state = null, active_run_id = null, archived = false, execution_state = 'ready' where instance_id = :instance and id = $1",
          [database.context.scope.taskId],
        );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      // 失败回归也通过真实更新解除等待，避免轮询与集群清理并发。
      await database.persistence
        .forInstance(database.instanceId)
        .execute(
          "update public.code_ui_sessions set state = null, active_run_id = null where instance_id = :instance and id = $1",
          [database.context.scope.taskId],
        );
      await Promise.allSettled(waiters);
      database.localInstance.cancelMaintenance();
    });

    it("暂停queued立即可迁移，子snapshot的autoDrain不覆盖根且输入原样保留", async () => {
      const { state } = makeState(database, "queued", false, true);
      await persist(state);
      const waiter = beginWait();
      const outcome = await Promise.race([
        waiter.done.then(() => "idle"),
        waiter.blocked.then(() => "waiting"),
      ]);
      expect(outcome).toBe("idle");
      expect(waiter.polls).not.toHaveBeenCalled();
      const root = await createCodeUiRepository(database.persistence).find(
        database.instanceId,
        database.context.scope.taskId,
      );
      expect(root?.state).toEqual(state);
      expect(root?.active_run_id).toBeNull();
    });

    it("根autoDrain=true的queued等待真实终态，先排列的暂停子快照不能提前放行", async () => {
      const { state } = makeState(database, "queued", true, false);
      await persist(state);
      const waiter = beginWait();
      expect(
        await Promise.race([
          waiter.done.then(() => "idle"),
          waiter.blocked.then(() => "waiting"),
        ]),
      ).toBe("waiting");
      expect(waiter.finished()).toBe(false);
      for (const input of state.inputs ?? []) input.status = "settled";
      const rootSnapshot = state.snapshots.find(
        (snapshot) => snapshot.sessionId === database.context.scope.taskId,
      );
      if (!rootSnapshot) throw new Error("真实Conversation没有根snapshot。");
      rootSnapshot.queue.items = [];
      await persist(state);
      await waiter.done;
      expect(waiter.finished()).toBe(true);
    });

    it.each(["archived", "revoking", "failed"])(
      "%s根Task的queued不被当成自动运行",
      async (condition) => {
        const { state } = makeState(database, "queued", true);
        await persist(state);
        await database.persistence
          .forInstance(database.instanceId)
          .execute(
            "update public.code_ui_sessions set archived = $2, execution_state = $3 where instance_id = :instance and id = $1",
            [
              database.context.scope.taskId,
              condition === "archived",
              condition === "archived" ? "ready" : condition,
            ],
          );
        const waiter = beginWait();
        expect(
          await Promise.race([
            waiter.done.then(() => "idle"),
            waiter.blocked.then(() => "waiting"),
          ]),
        ).toBe("idle");
        expect(waiter.polls).not.toHaveBeenCalled();
      },
    );

    it("reserved即使暂停、归档与failed仍等待，真实结算后才允许迁移", async () => {
      const { state } = makeState(database, "reserved", false);
      await persist(state);
      await database.persistence
        .forInstance(database.instanceId)
        .execute(
          "update public.code_ui_sessions set archived = true, execution_state = 'failed' where instance_id = :instance and id = $1",
          [database.context.scope.taskId],
        );
      const waiter = beginWait();
      await waiter.blocked;
      expect(waiter.finished()).toBe(false);
      for (const input of state.inputs ?? []) input.status = "settled";
      await persist(state);
      await waiter.done;
      expect(waiter.finished()).toBe(true);
    });

    it("active_run_id即使没有queued、暂停并归档仍等待真实Run终态", async () => {
      const { state, record } = makeState(database, "queued", false);
      state.inputs = [];
      for (const snapshot of state.snapshots) snapshot.queue.items = [];
      await persist(state, record.runId);
      await database.persistence
        .forInstance(database.instanceId)
        .execute(
          "update public.code_ui_sessions set archived = true, execution_state = 'failed' where instance_id = :instance and id = $1",
          [database.context.scope.taskId],
        );
      const waiter = beginWait();
      await waiter.blocked;
      expect(waiter.finished()).toBe(false);
      await persist(state);
      await waiter.done;
      expect(waiter.finished()).toBe(true);
    });
  },
);
