import { randomUUID } from "node:crypto";
import {
  instanceResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { prepareHarnessTask } from "../agent-runs/test-harness.js";
import { createChatRepository } from "../chat/repository.js";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { createCodeSessionFixture } from "../code-ui/host-session.fixture.js";
import { heldModel } from "../code-ui/model-stream.fixture.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createExecutionModeService } from "./execution-mode-service.js";
import { createExecutionModeStore } from "./execution-mode-store.js";

type CodeHost = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function waitActive(
  host: CodeHost,
  model: Awaited<ReturnType<typeof heldModel>>,
  requests: number,
) {
  // 仅测试同步期限：等真实HTTP模型请求与公开运行投影，不是业务运行时限额。
  await vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(requests);
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("running");
    },
    { timeout: 30_000 },
  );
  const snapshot = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const foregroundId = snapshot.control.activeWorks.find(
    (work) => work.kind === "primaryTurn",
  )?.foregroundExecutionId;
  if (!foregroundId) throw new Error("实际原编辑运行的前台身份缺失");
  return foregroundId;
}

async function editContextThroughHost(
  host: CodeHost,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  await host.command("sendText", { text: "模式应跟随稳定Task" });
  const first = await waitActive(host, model, 1);
  expect(
    (await host.command("stop", { expectedForegroundExecutionId: first })).body
      .result.status,
  ).toBe("accepted");
  const beforeEdit = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const row = beforeEdit.rows.window.find(
    (entry) => entry.kind === "userInput" && entry.origin === "realUser",
  );
  if (row?.kind !== "userInput") throw new Error("原编辑公开目标行缺失");
  const edited = await host.command(
    "editUserQuery",
    {
      target: { rowId: row.rowId, entityId: row.entityId },
      newText: "上下文分支换绑后继续",
      workspaceMode: "preserve",
    },
    randomUUID(),
    {
      baseRevision: beforeEdit.revision,
      baseLogEpoch: beforeEdit.logEpoch,
    },
  );
  expect(edited.body.result).toMatchObject({
    status: "accepted",
    result: { type: "editUserQuery", disposition: "rewind" },
  });
  const second = await waitActive(host, model, 2);
  expect(second).not.toBe(first);
  return second;
}

/** 只创建独占临时Postgres并重放正式迁移；不解析.env或连接任何现存数据库。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "执行模式持久化真实库 integration",
  () => {
    it("无Canvas Code Task支持两种id的模式激活、冷重启恢复和foreign实例隔离", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const { scope, threadId } = await prepareHarnessTask(database);
        const ownerScope = { instanceId: scope.instanceId };
        const sessionId = scope.taskId;
        const session = await database.persistence
          .forInstance(scope.instanceId)
          .queryOne<{ canvas_id: string | null; kind: string; mode: string }>(
            `select s.canvas_id, s.mode, p.kind
               from public.chat_sessions s
               join public.projects p on p.id=s.project_id and p.instance_id=s.instance_id
              where s.id=$1 and s.instance_id=:instance`,
            [sessionId],
          );
        expect(session).toEqual({
          canvas_id: null,
          kind: "code",
          mode: "code",
        });

        const foreignScope = { instanceId: randomUUID() };
        const createService = () =>
          createExecutionModeService({
            store: createExecutionModeStore(database.persistence),
          });
        const service = createService();
        for (const id of [sessionId, threadId]) {
          expect(await service.lookup(id, ownerScope)).toEqual({
            exists: true,
            mode: null,
          });
          expect(await service.hydrate(id, ownerScope)).toBe("agent");
        }
        await service.activate(sessionId, "plan", ownerScope);
        const atomicStore = createExecutionModeStore(database.persistence);
        expect(
          await atomicStore.save(scope.instanceId, sessionId, "plan"),
        ).toBe(true);

        const restarted = createService();
        for (const id of [sessionId, threadId]) {
          expect(await restarted.lookup(id, ownerScope)).toEqual({
            exists: true,
            mode: "plan",
          });
          expect(await restarted.hydrate(id, ownerScope)).toBe("plan");
        }
        await restarted.activate(threadId, "goal", ownerScope);
        const coldOwner = createService();
        const coldForeign = createService();
        const store = createExecutionModeStore(database.persistence);
        for (const id of [sessionId, threadId]) {
          expect(await coldForeign.lookup(id, foreignScope)).toEqual({
            exists: false,
            mode: null,
          });
          expect(await coldForeign.hydrate(id, foreignScope)).toBe("agent");
          expect(await store.save(foreignScope.instanceId, id, "solo")).toBe(
            false,
          );
          expect(await coldOwner.lookup(id, ownerScope)).toEqual({
            exists: true,
            mode: "goal",
          });
          expect(await coldOwner.hydrate(id, ownerScope)).toBe("goal");
        }
      } finally {
        await database.close();
      }
    });

    it("Design和Flow使用正式项目会话仓库创建后，两种id可持久往返现有六档模式", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const { scope, actor } = await prepareHarnessTask(database);
        const ownerScope = { instanceId: scope.instanceId };
        const projects = createProjectRepository(database.persistence);
        const chat = createChatRepository(database.persistence);
        const createService = () =>
          createExecutionModeService({
            store: createExecutionModeStore(database.persistence),
          });
        const modes = [
          "agent",
          "plan",
          "solo",
          "goal",
          "loop",
          "creative",
        ] as const;
        expect(
          createService()
            .listModes()
            .map((mode) => mode.id),
        ).toEqual(modes);
        for (const kind of ["design", "flow"] as const) {
          const created = await projects.createProject({
            instanceId: scope.instanceId,
            createdByClientId: actor.accessClientId,
            kind,
            name: `${kind}执行模式隔离回归`,
            slug: `mode-${kind}-${randomUUID()}`,
            description: null,
            canvasName: "主画布",
          });
          if (!created.canvas) throw new Error(`${kind}正式仓库未创建主画布`);
          const threadId = `mode-${kind}-${randomUUID()}`;
          const session = await chat.createSession(scope.instanceId, {
            canvasId: created.canvas.id,
            threadId,
            createdByClientId: actor.accessClientId,
          });
          if (!session) throw new Error("正式Design/Flow会话未创建");
          expect(session).toMatchObject({
            project_id: created.project.id,
            mode: kind,
          });
          const service = createService();
          for (const id of [session.id, threadId])
            expect(await service.lookup(id, ownerScope)).toEqual({
              exists: true,
              mode: null,
            });
          for (const mode of modes) {
            await service.activate(session.id, mode, ownerScope);
            const restarted = createService();
            for (const id of [session.id, threadId]) {
              expect(await restarted.lookup(id, ownerScope)).toEqual({
                exists: true,
                mode,
              });
              expect(await restarted.hydrate(id, ownerScope)).toBe(mode);
            }
          }
        }
      } finally {
        await database.close();
      }
    });

    it("原编辑HTTP真正换绑后，稳定会话id和新thread别名冷恢复模式，旧别名不再拥有持久行", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: CodeHost | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const instanceResponse = await host.client.request("/api/instance");
        expect(instanceResponse.status).toBe(200);
        const instance = instanceResponseSchema.parse(instanceResponse.body);
        const scope = { instanceId: instance.instanceId };
        const chat = createChatRepository(fixture.database.persistence);
        const original = await chat.findSessionThread(
          scope.instanceId,
          host.sessionId,
        );
        if (!original?.thread_id) throw new Error("原Code Task线程未实际绑定");
        expect(original).toMatchObject({ mode: "code", canvas_id: null });
        const createService = () =>
          createExecutionModeService({
            store: createExecutionModeStore(fixture.database.persistence),
          });
        await createService().activate(host.sessionId, "plan", scope);
        const second = await editContextThroughHost(host, model);
        const rebound = await chat.findSessionThread(
          scope.instanceId,
          host.sessionId,
        );
        if (!rebound?.thread_id) throw new Error("新上下文线程未实际绑定");
        expect(rebound.thread_id).not.toBe(original.thread_id);
        const restarted = createService();
        for (const id of [host.sessionId, rebound.thread_id]) {
          expect(await restarted.lookup(id, scope)).toEqual({
            exists: true,
            mode: "plan",
          });
          expect(await restarted.hydrate(id, scope)).toBe("plan");
        }
        expect(await restarted.lookup(original.thread_id, scope)).toEqual({
          exists: false,
          mode: null,
        });
        expect(await restarted.hydrate(original.thread_id, scope)).toBe(
          "agent",
        );
        const store = createExecutionModeStore(fixture.database.persistence);
        expect(
          await store.save(scope.instanceId, original.thread_id, "solo"),
        ).toBe(false);
        expect(await createService().hydrate(host.sessionId, scope)).toBe(
          "plan",
        );
        await host.command("stop", { expectedForegroundExecutionId: second });
      } finally {
        if (host) {
          const snapshot = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          if (snapshot.control.canStop) await host.command("stop", {});
          await host.dispose();
        }
        await model.close();
        await fixture.close();
      }
    });
  },
);
