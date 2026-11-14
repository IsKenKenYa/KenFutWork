import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupAdmission,
  type CodeTaskGroupStructure,
  type CodeTaskGroupTaskRef,
  type CodeTaskOrganizationTarget,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type HttpFixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;
type GroupRpc = (
  method: string,
  args?: unknown[],
) => ReturnType<HttpFixture["client"]["request"]>;
type PlacementFixture = Awaited<ReturnType<typeof createPlacementFixture>>;
type GroupReader = Awaited<ReturnType<typeof connectGroupReader>>;

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
    throw new AggregateError(failures, "Task 分组登记生命周期验证或清理失败", {
      cause: failures[0],
    });
}

async function readGroups(rpc: GroupRpc) {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

async function taskState(http: HttpFixture, taskId: string) {
  const scope = await http.client.request(`/api/code-ui/tasks/${taskId}/scope`);
  expect(scope.status, JSON.stringify(scope.body)).toBe(200);
  return { scope, snapshot: await snapshot(http, taskId) };
}

async function preparePlacement(rpc: GroupRpc, task: CodeTaskGroupTaskRef) {
  const groups = [];
  for (const [expectedRevision, title] of [
    [0, "继续保留的分组"],
    [1, "创建归属目标分组"],
  ] as const) {
    const response = await rpc("save", [
      { creationId: randomUUID(), expectedRevision, title },
    ]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    groups.push(codeTaskGroupSchema.parse(response.body.result));
  }
  const [retained, target] = groups;
  if (!retained || !target) throw new Error("真实分组创建未返回两个分组。");
  const before: CodeTaskGroupStructure = {
    revision: 2,
    groups: [retained, target],
    members: [],
    order: [
      { type: "group", key: target.id, sortOrder: 0 },
      { type: "group", key: retained.id, sortOrder: 1 },
    ],
  };
  expect(await readGroups(rpc)).toEqual(before);
  const intent = Object.freeze({
    tasks: [task],
    placement: { task, groupId: target.id, creationId: task.taskId },
  } satisfies CodeTaskGroupAdmission);
  const after: CodeTaskGroupStructure = {
    ...before,
    revision: 3,
    members: [
      {
        groupId: target.id,
        workspaceKey: task.workspaceIdentity,
        taskId: task.taskId,
        sortOrder: 0,
      },
    ],
  };
  return { intent, before, after };
}

async function createPlacementFixture(
  options: Parameters<typeof createCodeUiHttpFixture>[0] = {},
) {
  const http = await createCodeUiHttpFixture(options);
  let model: Awaited<ReturnType<typeof heldModel>> | undefined;
  let host: Host | undefined;
  try {
    model = await heldModel();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: http.client,
    });
    const activeHost = host;
    const activeModel = model;
    const rpc: GroupRpc = (method, args = []) =>
      activeHost.client.request("/api/code-ui/rpc", {
        service: "task-groups",
        method,
        args,
      });
    const task: CodeTaskGroupTaskRef = {
      hostId: "local",
      taskId: activeHost.sessionId,
      workspacePath: activeHost.workspacePath,
      workspaceIdentity: JSON.stringify([
        activeHost.projectId,
        activeHost.workspacePath,
      ]),
    };
    const beforeTask = await taskState(http, task.taskId);
    const placement = await preparePlacement(rpc, task);
    return {
      http,
      host: activeHost,
      model: activeModel,
      rpc,
      task,
      beforeTask,
      ...placement,
      close: () =>
        closeResources(
          [],
          [
            () => activeHost.dispose(),
            () => activeModel.close(),
            () => http.close(),
          ],
        ),
    };
  } catch (error) {
    await closeResources(
      [error],
      [() => host?.dispose(), () => model?.close(), () => http.close()],
    );
    throw error;
  }
}

async function connectGroupReader(http: HttpFixture) {
  const stream = await http.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId: randomUUID(),
      appVersion: "task-group-admit-lifecycle-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const rpc: GroupRpc = (method, args = []) =>
    http.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "task-groups",
      method,
      args,
    });
  return { stream, rpc };
}

async function waitForBlockedTask(lock: Client) {
  await vi.waitFor(
    async () => {
      await lock.query("select pg_stat_clear_snapshot()");
      const blocked = await lock.query(`select pid from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid()
        and state='active' and wait_event_type='Lock'
        and pg_backend_pid()=any(pg_blocking_pids(pid))
        and query ilike '%public.execution_task_owners%'
        and query ilike '%for update of s%'`);
      expect(blocked.rows).toHaveLength(1);
    },
    { timeout: 10_000 },
  ); // 本例真实 Task 行锁的等待期限。
}

async function nextTaskGroupNotification(reader: GroupReader) {
  for (;;) {
    const event = await nextHostServiceEvent(
      reader.stream,
      "broadcast",
      "onMessage",
    );
    if (event.data?.channel === "state:task-groups") return event;
  }
}

async function publishStoppedTask(fixture: PlacementFixture) {
  const text = "分组删除验收的原始输入";
  const sent = await fixture.host.command("sendText", { text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(fixture.model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例受控模型的真实 HTTP 请求。
  const stopped = await fixture.host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  const current = await waitPhase(
    fixture.http,
    fixture.task.taskId,
    "completedInterrupted",
  );
  expect(JSON.stringify(current.rows.window)).toContain(text);
  await vi.waitFor(() => expect(fixture.model.requests[0]?.closed).toBe(true), {
    timeout: 30_000,
  });
}

async function organizeTask(
  fixture: PlacementFixture,
  method: "archiveTask" | "deleteArchivedTask",
) {
  const current = await snapshot(fixture.http, fixture.task.taskId);
  if (!current.taskControl) throw new Error("真实 Task 缺少当前控制观察值。");
  const target: CodeTaskOrganizationTarget = {
    taskId: fixture.task.taskId,
    workspacePath: fixture.task.workspacePath,
    workspaceIdentity: fixture.task.workspaceIdentity,
    taskControl: structuredClone(current.taskControl),
  };
  return fixture.host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 Task 分组登记生命周期的真实 HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("Task行锁前关闭原连接会取消登记，另一连接以原创建意图明确重试成功", async () => {
      const fixture = await createPlacementFixture();
      const lock = new Client({
        connectionString: fixture.http.database.connectionString,
      });
      const failures: unknown[] = [];
      let locked = false;
      let settled = false;
      let admitting: ReturnType<GroupRpc> | undefined;
      try {
        const retry = await connectGroupReader(fixture.http);
        await lock.connect();
        await lock.query("begin");
        locked = true;
        await lock.query(
          "select id from public.code_ui_sessions where id=$1 for update",
          [fixture.task.taskId],
        );
        admitting = fixture.rpc("admit", [fixture.intent]).then((response) => {
          settled = true;
          return response;
        });
        await waitForBlockedTask(lock);
        fixture.host.stream.controller.abort();
        await fixture.host.stream.closed;
        await vi.waitFor(async () => {
          const closed = await fixture.rpc("read");
          expect(closed.status, JSON.stringify(closed.body)).toBe(404);
        });
        expect(settled).toBe(false);
        await lock.query("rollback");
        locked = false;
        const canceled = await admitting;
        expect(canceled.status, JSON.stringify(canceled.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(canceled.body).error.code,
        ).toBe("code_ui_not_found");
        expect(await readGroups(retry.rpc)).toEqual(fixture.before);
        const accepted = await retry.rpc("admit", [fixture.intent]);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        expect(codeUiRpcResponseSchema.parse(accepted.body)).toEqual({
          result: null,
        });
        expect(await readGroups(retry.rpc)).toEqual(fixture.after);
        expect(await taskState(fixture.http, fixture.task.taskId)).toEqual(
          fixture.beforeTask,
        );
        expect(fixture.model.requests).toHaveLength(0);
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
          () => admitting,
          () => fixture.close(),
        ]);
      }
    }, 90_000); // 独占 HTTP、真实 Task 行锁和连接关闭的集成期限。

    it("原分组SSE通知驱动另一连接读取新成员与一次修订，Task快照和Scope保持", async () => {
      const fixture = await createPlacementFixture();
      const failures: unknown[] = [];
      let receiving: Promise<void> | undefined;
      let frame: unknown;
      let observed: CodeTaskGroupStructure | undefined;
      let receiveError: unknown;
      try {
        const observer = await connectGroupReader(fixture.http);
        receiving = nextTaskGroupNotification(observer)
          .then(async (event) => {
            frame = event;
            observed = await readGroups(observer.rpc);
          })
          .catch((error: unknown) => {
            receiveError = error;
          });
        const admitted = await fixture.rpc("admit", [fixture.intent]);
        expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
        await vi.waitFor(
          () => {
            if (receiveError) throw receiveError;
            expect(frame).toMatchObject({
              event: "service",
              service: "broadcast",
              name: "onMessage",
              data: { channel: "state:task-groups", payload: {} },
            });
            expect(observed).toEqual(fixture.after);
          },
          { timeout: 5_000 },
        ); // 本机 SSE 通知及其真实读取的等待期限。
        expect(await taskState(fixture.http, fixture.task.taskId)).toEqual(
          fixture.beforeTask,
        );
        expect(fixture.model.requests).toHaveLength(0);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [
          () => fixture.close(),
          () => receiving,
        ]);
      }
    }, 90_000);

    it("真实placement提交后丢失回包，连续并发重放只保留一次登记且改组返回409", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createPlacementFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("首次登记测试未建立独占 PG 故障代理。");
        proxy.arm(fixture.task.taskId, { taskGroupPlacement: true });
        const unavailable = await fixture.rpc("admit", [fixture.intent]);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: fixture.task.taskId,
            targetTaskId: fixture.task.taskId,
            taskGroupPlacement: true,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        for (let round = 0; round < 2; round++) {
          const repeated = await fixture.rpc("admit", [fixture.intent]);
          expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
          expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        }
        const concurrent = await Promise.all([
          fixture.rpc("admit", [fixture.intent]),
          fixture.rpc("admit", [fixture.intent]),
          fixture.rpc("admit", [
            {
              ...fixture.intent,
              tasks: [fixture.task, fixture.task],
              placement: {
                ...fixture.intent.placement,
                groupId: fixture.intent.placement.groupId.toUpperCase(),
                creationId: fixture.task.taskId.toUpperCase(),
              },
            },
          ]),
        ]);
        for (const response of concurrent)
          expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        const conflict = await fixture.rpc("admit", [
          {
            ...fixture.intent,
            placement: { ...fixture.intent.placement, groupId: null },
          },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(conflict.body).error.code,
        ).toBe("task_group_revision_conflict");
        expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        expect(await taskState(fixture.http, fixture.task.taskId)).toEqual(
          fixture.beforeTask,
        );
        expect(fixture.model.requests).toHaveLength(0);
        expect(proxy.evidence().observerError).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [() => fixture.close()]);
      }
    }, 90_000); // 真实 COMMIT 丢包、公开重放与独占 PG 关闭的集成期限。

    it("placement后真实首发并停止，归档删除Task清除成员，旧请求不恢复成员或推进修订", async () => {
      const fixture = await createPlacementFixture();
      const failures: unknown[] = [];
      try {
        const admitted = await fixture.rpc("admit", [fixture.intent]);
        expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
        expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        await publishStoppedTask(fixture);
        const archived = await organizeTask(fixture, "archiveTask");
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        expect(await readGroups(fixture.rpc)).toEqual(fixture.after);
        const deleted = await organizeTask(fixture, "deleteArchivedTask");
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body.result).toBe(true);
        const afterDelete: CodeTaskGroupStructure = {
          ...fixture.after,
          revision: 4,
          members: [],
        };
        expect(await readGroups(fixture.rpc)).toEqual(afterDelete);
        for (let round = 0; round < 2; round++) {
          const oldPlacement = await fixture.rpc("admit", [fixture.intent]);
          expect(oldPlacement.status, JSON.stringify(oldPlacement.body)).toBe(
            404,
          );
          expect(
            applicationErrorResponseSchema.parse(oldPlacement.body).error.code,
          ).toBe("code_ui_not_found");
          const oldNatural = await fixture.rpc("admit", [
            { tasks: [fixture.task] },
          ]);
          expect(oldNatural.status, JSON.stringify(oldNatural.body)).toBe(200);
          expect(codeUiRpcResponseSchema.parse(oldNatural.body)).toEqual({
            result: null,
          });
          expect(await readGroups(fixture.rpc)).toEqual(afterDelete);
        }
        for (const path of [
          `/api/code-ui/sessions/${fixture.task.taskId}`,
          `/api/code-ui/tasks/${fixture.task.taskId}/scope`,
        ]) {
          const missing = await fixture.http.client.request(path);
          expect(missing.status, JSON.stringify(missing.body)).toBe(404);
        }
        expect(fixture.model.requests).toHaveLength(1);
        expect(fixture.model.requests[0]?.closed).toBe(true);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeResources(failures, [() => fixture.close()]);
      }
    }, 90_000); // 受控模型 HTTP 流、真实 Task 归档删除和临时资源关闭的期限。
  },
);
