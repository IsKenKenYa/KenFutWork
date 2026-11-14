import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupSave,
  type CodeTaskGroupStructure,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;
type GroupRpc = (
  method: string,
  args?: unknown[],
) => ReturnType<Fixture["client"]["request"]>;
type GroupConnection = Awaited<ReturnType<typeof connectGroups>>;

async function connectGroups(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId: randomUUID(),
      appVersion: "task-group-ungroup-lifecycle-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const rpc: GroupRpc = (method, args = []) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "task-groups",
      method,
      args,
    });
  return { stream, rpc };
}

async function readGroups(rpc: GroupRpc) {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

async function saveGroup(rpc: GroupRpc, input: CodeTaskGroupSave) {
  const response = await rpc("save", [input]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupSchema.parse(response.body.result);
}

async function prepareGroups(rpc: GroupRpc) {
  expect(await readGroups(rpc)).toEqual({
    revision: 0,
    groups: [],
    members: [],
    order: [],
  });
  const first = await saveGroup(rpc, {
    creationId: randomUUID(),
    expectedRevision: 0,
    title: "保留的较早分组",
  });
  const creation = {
    creationId: randomUUID(),
    expectedRevision: 1,
    title: "本轮取消的分组",
  };
  const target = await saveGroup(rpc, creation);
  const last = await saveGroup(rpc, {
    creationId: randomUUID(),
    expectedRevision: 2,
    title: "保留的较新分组",
  });
  const before = await readGroups(rpc);
  expect(before).toEqual({
    revision: 3,
    groups: [first, target, last],
    members: [],
    order: [
      { type: "group", key: last.id, sortOrder: 0 },
      { type: "group", key: target.id, sortOrder: 1 },
      { type: "group", key: first.id, sortOrder: 2 },
    ],
  });
  const intent = Object.freeze({
    id: target.id,
    expectedRevision: before.revision,
  });
  const after: CodeTaskGroupStructure = {
    revision: 4,
    groups: [first, last],
    members: [],
    order: [
      { type: "group", key: last.id, sortOrder: 0 },
      { type: "group", key: first.id, sortOrder: 1 },
    ],
  };
  return { before, after, creation, intent };
}

async function waitForBlockedGroupState(lock: Client) {
  await vi.waitFor(
    async () => {
      await lock.query("select pg_stat_clear_snapshot()");
      const blocked = await lock.query(`select pid from pg_stat_activity
        where datname=current_database() and pid<>pg_backend_pid()
          and state='active' and wait_event_type='Lock'
          and query ilike '%public.code_task_group_state%'`);
      expect(blocked.rows).toHaveLength(1);
    },
    { timeout: 10_000 },
  ); // 仅用于本例真实 PostgreSQL 行锁等待的期限。
}

async function nextTaskGroupNotification(connection: GroupConnection) {
  for (;;) {
    const event = await nextHostServiceEvent(
      connection.stream,
      "broadcast",
      "onMessage",
    );
    if (event.data?.channel === "state:task-groups") return event;
  }
}

async function closeLifecycleResources(
  failures: unknown[],
  resources: Array<() => unknown | Promise<unknown>>,
) {
  for (const close of resources) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "取消分组生命周期验证或清理失败", {
      cause: failures[0],
    });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原取消分组生命周期的真实 HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("关闭等待真实行锁的原连接取消事务，另一可信连接以原意图明确重试", async () => {
      const fixture = await createCodeUiHttpFixture();
      const lock = new Client({
        connectionString: fixture.database.connectionString,
      });
      const failures: unknown[] = [];
      let locked = false;
      let settled = false;
      let ungrouping: ReturnType<GroupRpc> | undefined;
      try {
        const retainedConnection = await connectGroups(fixture);
        const { before, after, intent } = await prepareGroups(
          retainedConnection.rpc,
        );
        const closingConnection = await connectGroups(fixture);
        await lock.connect();
        await lock.query("begin");
        locked = true;
        await lock.query(
          "select revision from public.code_task_group_state for update",
        );
        ungrouping = closingConnection
          .rpc("ungroup", [intent])
          .then((result) => {
            settled = true;
            return result;
          });
        await waitForBlockedGroupState(lock);
        closingConnection.stream.controller.abort();
        await closingConnection.stream.closed;
        await vi.waitFor(async () => {
          const closed = await closingConnection.rpc("read");
          expect(closed.status, JSON.stringify(closed.body)).toBe(404);
        });
        expect(settled).toBe(false);
        await lock.query("rollback");
        locked = false;
        const canceled = await ungrouping;
        expect(canceled.status, JSON.stringify(canceled.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(canceled.body).error.code,
        ).toBe("code_ui_not_found");
        expect(await readGroups(retainedConnection.rpc)).toEqual(before);
        const retried = await retainedConnection.rpc("ungroup", [intent]);
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(await readGroups(retainedConnection.rpc)).toEqual(after);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeLifecycleResources(failures, [
          async () => {
            try {
              if (locked) await lock.query("rollback");
            } finally {
              locked = false;
              await lock.end();
            }
          },
          () => ungrouping,
          () => fixture.close(),
        ]);
      }
    }, 90_000); // 独占 HTTP、真实行锁与连接关闭的集成期限。

    it("取消后的原分组通知让另一连接读取真实结构，保留其它根节点次序", async () => {
      const fixture = await createCodeUiHttpFixture();
      const failures: unknown[] = [];
      let receiving: Promise<void> | undefined;
      let frame: unknown;
      let receiveError: unknown;
      try {
        const source = await connectGroups(fixture);
        const { after, intent } = await prepareGroups(source.rpc);
        const observer = await connectGroups(fixture);
        receiving = nextTaskGroupNotification(observer).then(
          (event) => {
            frame = event;
          },
          (error: unknown) => {
            receiveError = error;
          },
        );
        const canceled = await source.rpc("ungroup", [intent]);
        expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
        await vi.waitFor(
          () => {
            if (receiveError) throw receiveError;
            expect(frame).toMatchObject({
              event: "service",
              service: "broadcast",
              name: "onMessage",
              data: { channel: "state:task-groups", payload: {} },
            });
          },
          { timeout: 5_000 },
        ); // 本机 SSE 的实际状态通知等待期限。
        expect(await readGroups(observer.rpc)).toEqual(after);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeLifecycleResources(failures, [
          () => fixture.close(),
          () => receiving,
        ]);
      }
    }, 90_000);

    it("真实取消事务提交后丢失回包，原意图连续和并发重放不再推进修订且旧保存不能恢复组", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("取消分组测试未建立独占 PG 故障代理。");
        const connection = await connectGroups(fixture);
        const { after, creation, intent } = await prepareGroups(connection.rpc);
        const key = JSON.stringify([
          "ungroup",
          intent.id.toLowerCase(),
          intent.expectedRevision,
        ]);
        proxy.arm(key, { taskGroupUngroup: true });
        const unavailable = await connection.rpc("ungroup", [intent]);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: key,
            taskGroupUngroup: true,
            targetGroupId: intent.id,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        expect(await readGroups(connection.rpc)).toEqual(after);
        for (let round = 0; round < 2; round++) {
          const replay = await connection.rpc("ungroup", [intent]);
          expect(replay.status, JSON.stringify(replay.body)).toBe(200);
          expect(await readGroups(connection.rpc)).toEqual(after);
        }
        const concurrent = await Promise.all([
          connection.rpc("ungroup", [intent]),
          connection.rpc("ungroup", [intent]),
          connection.rpc("ungroup", [
            { ...intent, id: intent.id.toUpperCase() },
          ]),
        ]);
        for (const response of concurrent)
          expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await readGroups(connection.rpc)).toEqual(after);
        for (const input of [
          creation,
          {
            id: intent.id,
            expectedRevision: after.revision,
            title: "取消后迟到的编辑",
          },
        ]) {
          const late = await connection.rpc("save", [input]);
          expect(late.status, JSON.stringify(late.body)).toBe(404);
          expect(
            applicationErrorResponseSchema.parse(late.body).error.code,
          ).toBe("task_group_not_found");
          expect(await readGroups(connection.rpc)).toEqual(after);
        }
        expect(proxy.evidence().observerError).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        await closeLifecycleResources(failures, [() => fixture.close()]);
      }
    }, 90_000); // 真实 COMMIT 故障、公开重放及独占 PG 资源关闭的期限。
  },
);
