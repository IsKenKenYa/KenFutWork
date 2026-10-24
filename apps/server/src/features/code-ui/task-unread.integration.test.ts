import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskProjectMoveInput,
  type CodeTaskUnreadControllerInput,
  type CodeTaskUnreadInput,
  type CodeTaskUnreadObservation,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { zcodeTaskMetaSchema } from "@zcode/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
const taskMetaSchema = zcodeTaskMetaSchema.extend({
  lastUnreadAt: z.number().int().nonnegative().safe(),
});
type TaskMeta = z.infer<typeof taskMetaSchema>;

function observedUnreadTarget(meta: TaskMeta): CodeTaskUnreadObservation {
  if (!meta.workspaceIdentity || !meta.taskControl)
    throw new Error("未读操作缺少公开Task身份与观察值。");
  return {
    taskId: meta.taskId,
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    taskControl: structuredClone(meta.taskControl),
    observedLastUnreadAt: meta.lastUnreadAt,
  };
}

async function readMeta(
  host: Host,
  client: Pick<Host["client"], "request"> = host.client,
) {
  const response = await client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function setUnread(host: Host, input: CodeTaskUnreadInput) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "setTaskUnread",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function mutateUnread(host: Host, input: CodeTaskUnreadControllerInput) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "window-controller",
    method: "mutateTask",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

function controllerUnreadInput(
  input: CodeTaskUnreadInput,
): CodeTaskUnreadControllerInput {
  const { unread, expectedUnreadAt, ...address } = input;
  return {
    address,
    mutation: unread
      ? { kind: "mark-unread" }
      : {
          kind: "mark-read",
          ...(expectedUnreadAt !== undefined ? { expectedUnreadAt } : {}),
        },
  };
}

async function expectUnreadReplay(
  host: Host,
  input: CodeTaskUnreadInput,
  result: TaskMeta,
) {
  expect(await setUnread(host, input)).toEqual(result);
  const responses = await Promise.all([
    setUnread(host, input),
    mutateUnread(host, controllerUnreadInput(input)),
  ]);
  for (const response of responses) expect(response).toEqual(result);
}

async function expectRpcError(
  host: Host,
  request: { service: string; method: string; args: unknown[] },
  status: number,
  code: string,
) {
  const response = await host.client.request("/api/code-ui/rpc", request);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(applicationErrorResponseSchema.parse(response.body).error.code).toBe(
    code,
  );
}

async function expectInvalidUnreadObservations(host: Host, initial: TaskMeta) {
  const input = { ...observedUnreadTarget(initial), unread: true };
  for (const change of [
    { observedLastUnreadAt: undefined },
    { observedLastUnreadAt: -1 },
    { observedLastUnreadAt: 1.5 },
    { observedLastUnreadAt: Number.MAX_SAFE_INTEGER + 1 },
    { taskControl: undefined },
    { extraField: true },
  ])
    await expectRpcError(
      host,
      {
        service: "zcode-task",
        method: "setTaskUnread",
        args: [{ ...input, ...change }],
      },
      400,
      "invalid_code_ui_request",
    );
  await expectRpcError(
    host,
    {
      service: "zcode-task",
      method: "setTaskUnread",
      args: [{ ...input, observedLastUnreadAt: 1 }],
    },
    409,
    "task_unread_conflict",
  );
  await expectRpcError(
    host,
    {
      service: "window-controller",
      method: "mutateTask",
      args: [
        {
          address: {
            ...observedUnreadTarget(initial),
            remoteSessionId: "other-source",
          },
          mutation: { kind: "mark-unread" },
        },
      ],
    },
    400,
    "invalid_code_ui_request",
  );
  expect(await readMeta(host)).toEqual(initial);
}

async function moveUnreadTask(
  fixture: Fixture,
  host: Host,
  meta: TaskMeta,
  current: protocol.ConversationSnapshot,
) {
  const directory = join(fixture.directory, "未读保持的目标项目");
  await mkdir(directory);
  const created = await host.client.request("/api/projects", {
    name: "未读保持的目标项目",
    kind: "code",
    work_dir: directory,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(created.body).project;
  const target = observedUnreadTarget(meta);
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId: target.taskId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    },
    sourceProjectId: target.taskControl.projectId,
    projectId: project.id,
    observedRevision: current.revision,
    addMissingRoot: true,
  };
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ result: null });
  const moved = await readMeta(host);
  expect(moved.taskControl?.projectId).toBe(project.id);
  expect(moved.taskControl?.branchGeneration).toBeGreaterThan(
    target.taskControl.branchGeneration,
  );
  return moved;
}

async function initializeObserver(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "task-unread-connection-integration",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  return stream;
}

async function expectClosedConnection(fixture: Fixture, connectionId: string) {
  await expect
    .poll(async () => {
      const response = await fixture.client.request("/api/code-ui/rpc", {
        connectionId,
        service: "project",
        method: "readProjects",
        args: [],
      });
      return response.status;
    })
    .toBe(404);
}

async function holdTask(fixture: Fixture, host: Host) {
  const blocker = new Client({
    connectionString: fixture.database.connectionString,
  });
  await blocker.connect();
  let held = false;
  try {
    await blocker.query("begin");
    held = true;
    const locked = await blocker.query<{ id: string }>(
      "select id from public.code_ui_sessions where instance_id=$1 and id=$2 for update",
      [fixture.actor.instanceId, host.sessionId],
    );
    expect(locked.rows).toEqual([{ id: host.sessionId }]);
    const identity = await blocker.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const pid = identity.rows[0]?.pid;
    if (pid === undefined) throw new Error("数据库锁连接缺少进程身份。");
    const release = async () => {
      if (!held) return;
      await blocker.query("rollback");
      held = false;
    };
    return {
      release,
      async waitBlocked() {
        await expect
          .poll(async () => {
            await blocker.query("select pg_stat_clear_snapshot()");
            const waiting = await blocker.query(
              `select pid from pg_stat_activity
                where datname=current_database() and pid<>pg_backend_pid()
                  and state='active' and wait_event_type='Lock'
                  and $1=any(pg_blocking_pids(pid))`,
              [pid],
            );
            return waiting.rows.length;
          })
          .toBe(1);
      },
      async close() {
        try {
          await release();
        } finally {
          await blocker.end();
        }
      },
    };
  } catch (error) {
    try {
      if (held) await blocker.query("rollback");
    } finally {
      await blocker.end();
    }
    throw error;
  }
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function expectTreeUnread(host: Host, meta: TaskMeta) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("公开项目树缺少本例已发表的根Task。");
  expect(task.lastUnreadAt).toBe(meta.lastUnreadAt);
  expect(task.unreadAt).toBe(meta.unreadAt);
  expect(task.taskControl).toEqual(meta.taskControl);
}

async function prepareStoppedTask(fixture: Fixture, host: Host, model: Model) {
  const accepted = await host.command("sendText", {
    text: "未读操作保留的原始任务正文",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例本机HTTP模型流，不属于产品治理值。
  const body = "未读操作前已经发表的助手正文";
  model.writeText(0, body);
  await vi.waitFor(
    async () =>
      expect(
        JSON.stringify((await snapshot(fixture, host.sessionId)).rows.window),
      ).toContain(body),
    { timeout: 30_000 },
  );
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  await waitPhase(fixture, host.sessionId, "completedInterrupted");
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  return snapshot(fixture, host.sessionId);
}

async function closeFixture(fixture: Fixture, model: Model, host?: Host) {
  const failures: unknown[] = [];
  for (const close of [
    () => host?.dispose(),
    () => model.close(),
    () => fixture.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "真实未读夹具未全部关闭。");
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Task未读的真实HTTP/RPC与PostgreSQL integration",
  () => {
    it("两个原入口多次标记及按观察读取清除，持久水位推进且Task正文、修订和权限保持", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareStoppedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        expect(initial.lastUnreadAt).toBe(0);
        expect(initial.unreadAt).toBeUndefined();

        const first = await setUnread(host, {
          ...observedUnreadTarget(initial),
          unread: true,
        });
        const firstMarker = z.number().int().positive().parse(first.unreadAt);
        expect(first.lastUnreadAt).toBe(firstMarker);
        expect(await readMeta(host)).toEqual(first);
        await expectTreeUnread(host, first);

        const read = await mutateUnread(host, {
          address: observedUnreadTarget(first),
          mutation: { kind: "mark-read", expectedUnreadAt: firstMarker },
        });
        expect(read.unreadAt).toBeUndefined();
        expect(read.lastUnreadAt).toBe(firstMarker);
        expect(await readMeta(host)).toEqual(read);
        await expectTreeUnread(host, read);

        const second = await mutateUnread(host, {
          address: observedUnreadTarget(read),
          mutation: { kind: "mark-unread" },
        });
        const secondMarker = z.number().int().positive().parse(second.unreadAt);
        expect(secondMarker).toBeGreaterThan(firstMarker);
        expect(second.lastUnreadAt).toBe(secondMarker);
        expect(await readMeta(host)).toEqual(second);
        await expectTreeUnread(host, second);

        const cleared = await setUnread(host, {
          ...observedUnreadTarget(second),
          unread: false,
          expectedUnreadAt: secondMarker,
        });
        expect(cleared.unreadAt).toBeUndefined();
        expect(cleared.lastUnreadAt).toBe(secondMarker);
        expect(await readMeta(host)).toEqual(cleared);
        await expectTreeUnread(host, cleared);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例真实模型HTTP流、Task停止与独占PostgreSQL关闭期限。

    it("同键顺序与并发重放返回原结果，旧清除保留新标记且同键异参返回公开409", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareStoppedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        const mark: CodeTaskUnreadInput = {
          ...observedUnreadTarget(initial),
          unread: true,
        };
        const [first, concurrent] = await Promise.all([
          setUnread(host, mark),
          mutateUnread(host, controllerUnreadInput(mark)),
        ]);
        expect(concurrent).toEqual(first);
        const firstMarker = z.number().int().positive().parse(first.unreadAt);
        await expectUnreadReplay(host, mark, first);
        expect(await readMeta(host)).toEqual(first);

        const clear: CodeTaskUnreadInput = {
          ...observedUnreadTarget(first),
          unread: false,
          expectedUnreadAt: firstMarker,
        };
        const read = await setUnread(host, clear);
        expect(read.unreadAt).toBeUndefined();
        expect(read.lastUnreadAt).toBe(firstMarker);
        await expectUnreadReplay(host, clear, read);

        const second = await setUnread(host, {
          ...observedUnreadTarget(read),
          unread: true,
        });
        const secondMarker = z.number().int().positive().parse(second.unreadAt);
        expect(secondMarker).toBeGreaterThan(firstMarker);
        await expectUnreadReplay(host, mark, first);
        await expectUnreadReplay(host, clear, read);
        expect(await readMeta(host)).toEqual(second);
        await expectTreeUnread(host, second);

        const oldClear: CodeTaskUnreadInput = {
          ...observedUnreadTarget(second),
          unread: false,
          expectedUnreadAt: secondMarker,
        };
        const third = await mutateUnread(host, {
          address: observedUnreadTarget(second),
          mutation: { kind: "mark-unread" },
        });
        expect(
          z.number().int().positive().parse(third.unreadAt),
        ).toBeGreaterThan(secondMarker);
        expect(await setUnread(host, oldClear)).toEqual(third);
        await expectUnreadReplay(host, oldClear, third);
        expect(await readMeta(host)).toEqual(third);
        await expectTreeUnread(host, third);

        const conflict = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "setTaskUnread",
          args: [{ ...clear, expectedUnreadAt: 0 }],
        });
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        const error = applicationErrorResponseSchema.parse(conflict.body);
        expect(error.error.code).toBe("task_unread_conflict");
        expect(await readMeta(host)).toEqual(third);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例真实并发RPC、Task停止与独占PostgreSQL关闭期限。

    it("无效观察拒绝写入，移动保留未读并拒绝旧代际，删除后迟到请求不能恢复Task", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareStoppedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        await expectInvalidUnreadObservations(host, initial);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const original: CodeTaskUnreadInput = {
          ...observedUnreadTarget(initial),
          unread: true,
        };
        const marked = await setUnread(host, original);
        const marker = z.number().int().positive().parse(marked.unreadAt);
        const moved = await moveUnreadTask(fixture, host, marked, before);
        expect(moved.unreadAt).toBe(marker);
        expect(moved.lastUnreadAt).toBe(marked.lastUnreadAt);
        await expectRpcError(
          host,
          { service: "zcode-task", method: "setTaskUnread", args: [original] },
          409,
          "task_unread_conflict",
        );
        await expectRpcError(
          host,
          {
            service: "window-controller",
            method: "mutateTask",
            args: [
              {
                address: observedUnreadTarget(marked),
                mutation: { kind: "mark-read", expectedUnreadAt: marker },
              },
            ],
          },
          409,
          "task_unread_conflict",
        );
        expect(await readMeta(host)).toEqual(moved);
        const movedSnapshot = await snapshot(fixture, host.sessionId);
        expect(movedSnapshot.rows.window).toEqual(before.rows.window);
        expect(movedSnapshot.goal).toEqual(before.goal);
        const movedScope = await readScope(host);
        const current: CodeTaskUnreadInput = {
          ...observedUnreadTarget(moved),
          unread: true,
        };
        const updated = await setUnread(host, current);
        expect(updated.lastUnreadAt).toBeGreaterThan(moved.lastUnreadAt);
        expect(updated.unreadAt).toBe(updated.lastUnreadAt);
        expect(await snapshot(fixture, host.sessionId)).toEqual(movedSnapshot);
        expect(await readScope(host)).toEqual(movedScope);

        const deleted = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [observedUnreadTarget(updated)],
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        for (const intent of [original, current])
          await expectRpcError(
            host,
            { service: "zcode-task", method: "setTaskUnread", args: [intent] },
            404,
            "code_ui_not_found",
          );
        const missing = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "getTaskMeta",
          args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
        });
        expect(missing.status, JSON.stringify(missing.body)).toBe(200);
        expect(missing.body.result).toBeNull();
        for (const path of [
          `/api/code-ui/sessions/${host.sessionId}`,
          `/api/code-ui/tasks/${host.sessionId}/scope`,
        ]) {
          const response = await host.client.request(path);
          expect(response.status, JSON.stringify(response.body)).toBe(404);
        }
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例原移动、删除与独占PostgreSQL关闭期限。

    it("两个独立实例拒绝对方的原Task未读地址并保留各自标记、正文和权限", async () => {
      const leftFixture = await createCodeUiHttpFixture();
      const leftModel = await heldModel();
      let left: Host | undefined;
      let rightFixture: Fixture | undefined;
      let rightModel: Model | undefined;
      let right: Host | undefined;
      const failures: unknown[] = [];
      try {
        left = await createCodeSessionFixture(leftModel.baseUrl, {
          client: leftFixture.client,
        });
        const leftBefore = await prepareStoppedTask(
          leftFixture,
          left,
          leftModel,
        );
        const leftScope = await readScope(left);
        rightFixture = await createCodeUiHttpFixture();
        rightModel = await heldModel();
        right = await createCodeSessionFixture(rightModel.baseUrl, {
          client: rightFixture.client,
        });
        const rightBefore = await prepareStoppedTask(
          rightFixture,
          right,
          rightModel,
        );
        const rightScope = await readScope(right);
        expect(rightFixture.actor.instanceId).not.toBe(
          leftFixture.actor.instanceId,
        );
        const leftInput: CodeTaskUnreadInput = {
          ...observedUnreadTarget(await readMeta(left)),
          unread: true,
        };
        const rightInput: CodeTaskUnreadInput = {
          ...observedUnreadTarget(await readMeta(right)),
          unread: true,
        };
        const leftMarked = await setUnread(left, leftInput);
        const rightMarked = await setUnread(right, rightInput);
        await expectRpcError(
          left,
          {
            service: "zcode-task",
            method: "setTaskUnread",
            args: [rightInput],
          },
          404,
          "code_ui_not_found",
        );
        await expectRpcError(
          right,
          {
            service: "window-controller",
            method: "mutateTask",
            args: [controllerUnreadInput(leftInput)],
          },
          404,
          "code_ui_not_found",
        );
        expect(await readMeta(left)).toEqual(leftMarked);
        expect(await readMeta(right)).toEqual(rightMarked);
        expect(await snapshot(leftFixture, left.sessionId)).toEqual(leftBefore);
        expect(await snapshot(rightFixture, right.sessionId)).toEqual(
          rightBefore,
        );
        expect(await readScope(left)).toEqual(leftScope);
        expect(await readScope(right)).toEqual(rightScope);
        expect(leftModel.requests).toHaveLength(1);
        expect(rightModel.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          async () => {
            if (rightFixture && rightModel)
              await closeFixture(rightFixture, rightModel, right);
            else await rightFixture?.close();
          },
          () => closeFixture(leftFixture, leftModel, left),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "两个实例的未读验证或清理失败。", {
          cause: failures[0],
        });
    }, 120_000); // 两个独占HTTP/SSE、模型端点与PostgreSQL实例的关闭期限。

    it("连接关闭取消等待根Task锁的原清除请求，新连接以同一观察继续且正文、修订和权限保持", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let blocker: Awaited<ReturnType<typeof holdTask>> | undefined;
      let writing: ReturnType<Fixture["client"]["request"]> | undefined;
      const failures: unknown[] = [];
      try {
        expect(fixture.database.replayed).toContain("20261024113915");
        expect(fixture.database.replayed).toHaveLength(
          fixture.database.expectedMigrations,
        );
        expect(fixture.database.secondReplay).toEqual([]);
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareStoppedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const marked = await setUnread(host, {
          ...observedUnreadTarget(await readMeta(host)),
          unread: true,
        });
        const marker = z.number().int().positive().parse(marked.unreadAt);
        const input: CodeTaskUnreadInput = {
          ...observedUnreadTarget(marked),
          unread: false,
          expectedUnreadAt: marker,
        };
        const observer = await initializeObserver(fixture);
        blocker = await holdTask(fixture, host);
        writing = host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "setTaskUnread",
          args: [input],
        });
        let settled = false;
        void writing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await blocker.waitBlocked();
        host.stream.controller.abort();
        await host.stream.closed;
        const oldConnectionId = host.stream.ready.hello.connectionId;
        await expectClosedConnection(fixture, oldConnectionId);
        expect(settled).toBe(false);
        await blocker.release();
        const rejected = await writing;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        const error = applicationErrorResponseSchema.parse(rejected.body).error;
        expect(error.code).toBe("code_ui_not_found");
        expect(error.message).toContain("连接");
        expect(await readMeta(host, fixture.client)).toEqual(marked);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        const continued = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: observer.ready.hello.connectionId,
          service: "zcode-task",
          method: "setTaskUnread",
          args: [input],
        });
        expect(continued.status, JSON.stringify(continued.body)).toBe(200);
        const cleared = taskMetaSchema.parse(continued.body.result);
        expect(cleared.unreadAt).toBeUndefined();
        expect(cleared.lastUnreadAt).toBe(marker);
        expect(await readMeta(host, fixture.client)).toEqual(cleared);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => blocker?.release(),
          () => writing?.then(() => undefined),
          () => blocker?.close(),
          () => closeFixture(fixture, model, host),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "未读连接关闭验证或清理失败。", {
          cause: failures[0],
        });
    }, 90_000); // 本例原SSE关闭、真实PG锁等待及全部资源释放的期限。
  },
);
