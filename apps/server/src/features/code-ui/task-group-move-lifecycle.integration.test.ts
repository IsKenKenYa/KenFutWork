import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupMove,
  type CodeTaskGroupStructure,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
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
      appVersion: "task-group-move-lifecycle-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  codeUiRpcResponseSchema.parse(initialized.body);
  const rpc: GroupRpc = (method, args = []) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "task-groups",
      method,
      args,
    });
  return { stream, rpc };
}

async function accepted(rpc: GroupRpc, method: string, args: unknown[] = []) {
  const response = await rpc(method, args);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeUiRpcResponseSchema.parse(response.body).result;
}

async function readGroups(rpc: GroupRpc) {
  return codeTaskGroupStructureSchema.parse(await accepted(rpc, "read"));
}

async function prepareGroups(rpc: GroupRpc) {
  expect(await readGroups(rpc)).toEqual({
    revision: 0,
    groups: [],
    members: [],
    order: [],
  });
  const groups = [];
  for (const [expectedRevision, title] of [
    [0, "保留的较早分组"],
    [1, "本轮移动的分组"],
    [2, "保留的较新分组"],
  ] as const)
    groups.push(
      codeTaskGroupSchema.parse(
        await accepted(rpc, "save", [
          { creationId: randomUUID(), expectedRevision, title },
        ]),
      ),
    );
  const [first, target, last] = groups;
  if (!first || !target || !last)
    throw new Error("移动材料未返回三个真实分组。");
  const before: CodeTaskGroupStructure = {
    revision: 3,
    groups: [first, target, last],
    members: [],
    order: [
      { type: "group", key: last.id, sortOrder: 0 },
      { type: "group", key: target.id, sortOrder: 1 },
      { type: "group", key: first.id, sortOrder: 2 },
    ],
  };
  expect(await readGroups(rpc)).toEqual(before);
  const intent = Object.freeze({
    node: { type: "group", groupId: target.id },
    sourceGroupId: null,
    groupId: null,
    expectedRevision: before.revision,
    anchor: { node: { type: "group", groupId: first.id }, side: "after" },
  } satisfies CodeTaskGroupMove);
  const after: CodeTaskGroupStructure = {
    ...before,
    revision: 4,
    order: [
      { type: "group", key: last.id, sortOrder: 0 },
      { type: "group", key: first.id, sortOrder: 1 },
      { type: "group", key: target.id, sortOrder: 2 },
    ],
  };
  return { before, after, intent, first, target, last };
}

async function waitForBlockedGroupState(lock: Client) {
  await vi.waitFor(
    async () => {
      await lock.query("select pg_stat_clear_snapshot()");
      const blocked = await lock.query(`select pid from pg_stat_activity
        where datname=current_database() and pid<>pg_backend_pid()
          and state='active' and wait_event_type='Lock'
          and pg_backend_pid()=any(pg_blocking_pids(pid))
          and query ilike '%public.code_task_group_state%'`);
      expect(blocked.rows).toHaveLength(1);
    },
    { timeout: 10_000 },
  ); // 仅等待本例原移动请求阻塞于真实 PostgreSQL 组织行锁。
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

async function closeResources(
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
    throw new AggregateError(failures, "分组移动生命周期验证或清理失败", {
      cause: failures[0],
    });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组移动生命周期的真实 HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("关闭等待组织行锁的原连接取消移动，另一可信连接以原意图明确重试", async () => {
      const fixture = await createCodeUiHttpFixture();
      const lock = new Client({
        connectionString: fixture.database.connectionString,
      });
      const failures: unknown[] = [];
      let locked = false;
      let settled = false;
      let moving: ReturnType<GroupRpc> | undefined;
      try {
        const retained = await connectGroups(fixture);
        const { before, after, intent } = await prepareGroups(retained.rpc);
        const closing = await connectGroups(fixture);
        await lock.connect();
        await lock.query("begin");
        locked = true;
        await lock.query(
          "select revision from public.code_task_group_state where instance_id=$1 for update",
          [fixture.database.instanceId],
        );
        moving = closing.rpc("move", [intent]).then((response) => {
          settled = true;
          return response;
        });
        await waitForBlockedGroupState(lock);
        closing.stream.controller.abort();
        await closing.stream.closed;
        await vi.waitFor(async () => {
          const closed = await closing.rpc("read");
          expect(closed.status, JSON.stringify(closed.body)).toBe(404);
          expect(
            applicationErrorResponseSchema.parse(closed.body).error.code,
          ).toBe("code_ui_not_found");
        });
        expect(settled).toBe(false);
        await lock.query("rollback");
        locked = false;
        const canceled = await moving;
        expect(canceled.status, JSON.stringify(canceled.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(canceled.body).error.code,
        ).toBe("code_ui_not_found");
        expect(await readGroups(retained.rpc)).toEqual(before);
        expect(await accepted(retained.rpc, "move", [intent])).toBeNull();
        expect(await readGroups(retained.rpc)).toEqual(after);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [
          async () => {
            try {
              if (locked) await lock.query("rollback");
            } finally {
              locked = false;
              await lock.end();
            }
          },
          () => moving,
          () => fixture.close(),
        ]);
      }
    }, 90_000); // 独占 HTTP、SSE、真实组织行锁与取消重试的关闭期限。

    it("原分组SSE通知驱动另一连接读取移动后的一次修订和完整根顺序", async () => {
      const fixture = await createCodeUiHttpFixture();
      const failures: unknown[] = [];
      let receiving: Promise<void> | undefined;
      let frame: unknown;
      let observed: CodeTaskGroupStructure | undefined;
      let receiveError: unknown;
      try {
        const source = await connectGroups(fixture);
        const { after, intent } = await prepareGroups(source.rpc);
        const observer = await connectGroups(fixture);
        receiving = nextTaskGroupNotification(observer)
          .then(async (event) => {
            frame = event;
            observed = await readGroups(observer.rpc);
          })
          .catch((error: unknown) => {
            receiveError = error;
          });
        expect(await accepted(source.rpc, "move", [intent])).toBeNull();
        await vi.waitFor(
          () => {
            if (receiveError) throw receiveError;
            expect(frame).toMatchObject({
              event: "service",
              service: "broadcast",
              name: "onMessage",
              data: { channel: "state:task-groups", payload: {} },
            });
            expect(observed).toEqual(after);
          },
          { timeout: 5_000 },
        ); // 本机 SSE 通知及另一可信连接真实读取的等待期限。
        expect(await readGroups(source.rpc)).toEqual(after);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [
          () => fixture.close(),
          () => receiving,
        ]);
      }
    }, 90_000); // 独占 HTTP、真实分组广播和 SSE 资源关闭的期限。

    it("不同可信连接同键并发移动只推进一次修订，后续新增组后原意图重放保持顺序", async () => {
      const fixture = await createCodeUiHttpFixture();
      const failures: unknown[] = [];
      try {
        const firstConnection = await connectGroups(fixture);
        const { after, intent } = await prepareGroups(firstConnection.rpc);
        const secondConnection = await connectGroups(fixture);
        const uppercase = {
          ...intent,
          node: { ...intent.node, groupId: intent.node.groupId.toUpperCase() },
          anchor: {
            ...intent.anchor,
            node: {
              ...intent.anchor.node,
              groupId: intent.anchor.node.groupId.toUpperCase(),
            },
          },
        };
        const responses = await Promise.all([
          firstConnection.rpc("move", [intent]),
          secondConnection.rpc("move", [intent]),
          secondConnection.rpc("move", [uppercase]),
        ]);
        for (const response of responses) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(codeUiRpcResponseSchema.parse(response.body)).toEqual({
            result: null,
          });
        }
        expect(await readGroups(firstConnection.rpc)).toEqual(after);
        const added = codeTaskGroupSchema.parse(
          await accepted(firstConnection.rpc, "save", [
            {
              creationId: randomUUID(),
              expectedRevision: after.revision,
              title: "移动后新增的保留分组",
            },
          ]),
        );
        const later: CodeTaskGroupStructure = {
          revision: 5,
          groups: [...after.groups, added],
          members: [],
          order: [
            { type: "group", key: added.id, sortOrder: 0 },
            ...after.order.map((node) => ({
              ...node,
              sortOrder: node.sortOrder + 1,
            })),
          ],
        };
        expect(await readGroups(secondConnection.rpc)).toEqual(later);
        expect(
          await accepted(secondConnection.rpc, "move", [intent]),
        ).toBeNull();
        expect(await readGroups(firstConnection.rpc)).toEqual(later);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [() => fixture.close()]);
      }
    }, 90_000); // 两条真实连接同键并发、后续整理和旧意图重放的独占期限。

    it("同一组织修订的两个不同节点移动只接纳一个，失败意图不能覆盖获胜顺序", async () => {
      const fixture = await createCodeUiHttpFixture();
      const failures: unknown[] = [];
      try {
        const firstConnection = await connectGroups(fixture);
        const { before, after, intent, first, target, last } =
          await prepareGroups(firstConnection.rpc);
        const secondConnection = await connectGroups(fixture);
        const competing: CodeTaskGroupMove = {
          node: { type: "group", groupId: last.id },
          sourceGroupId: null,
          groupId: null,
          expectedRevision: before.revision,
          anchor: {
            node: { type: "group", groupId: first.id },
            side: "after",
          },
        };
        const responses = await Promise.all([
          firstConnection.rpc("move", [intent]),
          secondConnection.rpc("move", [competing]),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([
          200, 409,
        ]);
        for (const response of responses) {
          if (response.status === 200)
            expect(codeUiRpcResponseSchema.parse(response.body)).toEqual({
              result: null,
            });
          else
            expect(
              applicationErrorResponseSchema.parse(response.body).error.code,
            ).toBe("task_group_revision_conflict");
        }
        const firstWon = responses[0]?.status === 200;
        const expected: CodeTaskGroupStructure = firstWon
          ? after
          : {
              ...before,
              revision: 4,
              order: [
                { type: "group", key: target.id, sortOrder: 0 },
                { type: "group", key: first.id, sortOrder: 1 },
                { type: "group", key: last.id, sortOrder: 2 },
              ],
            };
        expect(await readGroups(firstConnection.rpc)).toEqual(expected);
        const winner = firstWon ? intent : competing;
        const loser = firstWon ? competing : intent;
        expect(
          await accepted(secondConnection.rpc, "move", [winner]),
        ).toBeNull();
        const rejected = await firstConnection.rpc("move", [loser]);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(rejected.body).error.code,
        ).toBe("task_group_revision_conflict");
        expect(await readGroups(secondConnection.rpc)).toEqual(expected);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [() => fixture.close()]);
      }
    }, 90_000); // 同修订竞争、获胜意图重放和冲突保持的真实集成期限。
  },
);
