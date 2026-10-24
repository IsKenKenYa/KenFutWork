import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskProjectMoveInput,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function rpc(fixture: Fixture, host: Host, args: unknown[]) {
  return fixture.client.request("/api/code-ui/rpc", {
    connectionId: host.stream.ready.hello.connectionId,
    service: "project",
    method: "moveTask",
    args,
  });
}

async function readState(fixture: Fixture, host: Host, projectId: string) {
  const scopeResponse = await fixture.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  const targetResponse = await fixture.client.request(
    `/api/projects/${projectId}`,
  );
  expect(scopeResponse.status, JSON.stringify(scopeResponse.body)).toBe(200);
  expect(targetResponse.status, JSON.stringify(targetResponse.body)).toBe(200);
  return {
    scope: codeTaskScopeResponseSchema.parse(scopeResponse.body).scope,
    snapshot: protocol.conversationSnapshotSchema.parse(await host.snapshot()),
    project: targetResponse.body.project,
  };
}

async function prepareMove(fixture: Fixture, host: Host) {
  const path = join(fixture.directory, "移动边界目标目录");
  await mkdir(path);
  const target = await host.client.request("/api/projects", {
    name: "移动边界目标项目",
    kind: "code",
    work_dir: path,
  });
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(target.body).project;
  const before = await readState(fixture, host, project.id);
  const input: CodeTaskProjectMoveInput = {
    task: { taskId: host.sessionId, workspacePath: host.workspacePath },
    sourceProjectId: host.projectId,
    projectId: project.id,
    observedRevision: before.snapshot.revision,
    addMissingRoot: true,
  };
  return { before, input };
}

async function initializeObserver(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const response = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "task-project-move-boundaries-integration",
      clientKind: "web",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return stream;
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
    await blocker.query(
      "select id from public.code_ui_sessions where instance_id=$1 and id=$2 for update",
      [fixture.actor.instanceId, host.sessionId],
    );
    const result = await blocker.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const pid = result.rows[0]?.pid;
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

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task跨项目移动参数与连接边界的真实HTTP、SSE和PostgreSQL integration",
  () => {
    it("仅接受一个完整移动参数，非法调用保留原项目、Task和权限，合法原意图仍可执行", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { before, input } = await prepareMove(fixture, host);
        if (!before.snapshot.taskControl)
          throw new Error("公开快照缺少原Task控制观察值。");
        const invalid = [
          [input, { addMissingRoot: true }],
          [],
          [null],
          [{ ...input, unknown: true }],
          [{ ...input, task: { ...input.task, unknown: true } }],
        ];
        for (const args of invalid) {
          const rejected = await rpc(fixture, host, args);
          expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
          applicationErrorResponseSchema.parse(rejected.body);
          expect(await readState(fixture, host, input.projectId)).toEqual(
            before,
          );
        }
        const moved = await rpc(fixture, host, [input]);
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body).toEqual({ result: null });
        const after = await readState(fixture, host, input.projectId);
        expect(after.scope).toMatchObject({
          taskId: host.sessionId,
          projectId: input.projectId,
          rootDirectory: before.scope.rootDirectory,
          additionalDirectories: before.scope.additionalDirectories,
          sandboxMode: before.scope.sandboxMode,
          generation: before.scope.generation + 1,
        });
        expect(after.snapshot.taskControl).toMatchObject({
          projectId: input.projectId,
          branchGeneration: before.snapshot.taskControl.branchGeneration + 1,
        });
        expect(after.snapshot.rows.window).toEqual(before.snapshot.rows.window);
        expect(model.requests).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => fixture.close(),
          () => model.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "移动边界验证或清理失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PostgreSQL及受控模型服务的验证期限。

    it("连接关闭取消尚在等待锁的移动，保留原Task和目标项目，新连接可用原意图移动", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let blocker: Awaited<ReturnType<typeof holdTask>> | undefined;
      let moving: ReturnType<typeof rpc> | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { before, input } = await prepareMove(fixture, host);
        const observer = await initializeObserver(fixture);
        blocker = await holdTask(fixture, host);
        moving = rpc(fixture, host, [input]);
        await blocker.waitBlocked();
        host.stream.controller.abort();
        await host.stream.closed;
        const closedConnectionId = host.stream.ready.hello.connectionId;
        await expect
          .poll(
            async () =>
              (
                await fixture.client.request("/api/code-ui/rpc", {
                  connectionId: closedConnectionId,
                  service: "project",
                  method: "readProjects",
                  args: [],
                })
              ).status,
          )
          .toBe(404);
        await blocker.release();
        const rejected = await moving;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(rejected.body).error.message,
        ).toContain("连接");
        expect(await readState(fixture, host, input.projectId)).toEqual(before);
        const moved = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: observer.ready.hello.connectionId,
          service: "project",
          method: "moveTask",
          args: [input],
        });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        const after = await readState(fixture, host, input.projectId);
        expect(after.scope).toMatchObject({
          projectId: input.projectId,
          rootDirectory: before.scope.rootDirectory,
          additionalDirectories: before.scope.additionalDirectories,
          generation: before.scope.generation + 1,
        });
        expect(after.snapshot.rows.window).toEqual(before.snapshot.rows.window);
        expect(model.requests).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => blocker?.release(),
          () => moving?.then(() => undefined),
          () => blocker?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "移动关闭验证或清理失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占HTTP、SSE关闭、真实PG锁竞争及全部资源释放的验证期限。

    it("宿主关闭等待移动事务退出，取消未接纳的移动且不改变Task和目标项目", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let blocker: Awaited<ReturnType<typeof holdTask>> | undefined;
      let moving: ReturnType<typeof rpc> | undefined;
      let closing: Promise<void> | undefined;
      let closed = false;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { before, input } = await prepareMove(fixture, host);
        blocker = await holdTask(fixture, host);
        moving = rpc(fixture, host, [input]);
        await blocker.waitBlocked();
        closing = fixture.app.kernel
          .get("codeUi")
          .closeConnections()
          .then(() => {
            closed = true;
          });
        const rejectedRead = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: host.stream.ready.hello.connectionId,
          service: "project",
          method: "readProjects",
          args: [],
        });
        expect(rejectedRead.status, JSON.stringify(rejectedRead.body)).toBe(
          404,
        );
        expect(closed).toBe(false);
        await blocker.release();
        const rejected = await moving;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        applicationErrorResponseSchema.parse(rejected.body);
        await closing;
        expect(closed).toBe(true);
        expect(await readState(fixture, host, input.projectId)).toEqual(before);
        expect(model.requests).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => blocker?.release(),
          () => moving?.then(() => undefined),
          () => closing,
          () => blocker?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "移动宿主关闭验证或清理失败", {
          cause: failures[0],
        });
    }, 60_000); // 原宿主关闭、真实PG等待及在途操作全部退出的验证期限。

    it.each([
      { closed: "首个连接", closeFirst: true, extraOnline: false },
      { closed: "第二个连接", closeFirst: false, extraOnline: false },
      { closed: "首个连接且另外两路在线", closeFirst: true, extraOnline: true },
    ])(
      "同键并发等待时关闭$closed，在线连接继续原意图且只推进一次授权版本",
      async ({ closeFirst, extraOnline }) => {
        const fixture = await createCodeUiHttpFixture();
        const model = await heldModel();
        let host: Host | undefined;
        let blocker: Awaited<ReturnType<typeof holdTask>> | undefined;
        let first: ReturnType<typeof rpc> | undefined;
        let second: ReturnType<typeof rpc> | undefined;
        let third: ReturnType<typeof rpc> | undefined;
        const failures: unknown[] = [];
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const { before, input } = await prepareMove(fixture, host);
          const observer = await initializeObserver(fixture);
          const additionalObserver = extraOnline
            ? await initializeObserver(fixture)
            : undefined;
          const observerInput = {
            connectionId: observer.ready.hello.connectionId,
            service: "project",
            method: "moveTask",
            args: [input],
          };
          blocker = await holdTask(fixture, host);
          first = rpc(fixture, host, [input]);
          await blocker.waitBlocked();
          second = fixture.client.request("/api/code-ui/rpc", observerInput);
          if (additionalObserver)
            third = fixture.client.request("/api/code-ui/rpc", {
              ...observerInput,
              connectionId: additionalObserver.ready.hello.connectionId,
            });
          expect(await readState(fixture, host, input.projectId)).toEqual(
            before,
          );
          const closingStream = closeFirst ? host.stream : observer;
          closingStream.controller.abort();
          await closingStream.closed;
          const closedConnectionId = closingStream.ready.hello.connectionId;
          await expect
            .poll(
              async () =>
                (
                  await fixture.client.request("/api/code-ui/rpc", {
                    connectionId: closedConnectionId,
                    service: "project",
                    method: "readProjects",
                    args: [],
                  })
                ).status,
            )
            .toBe(404);
          await blocker.release();
          const results = await Promise.all(
            third ? [first, second, third] : [first, second],
          );
          const closed = results[closeFirst ? 0 : 1];
          const online = results[closeFirst ? 1 : 0];
          expect(closed.status, JSON.stringify(closed.body)).toBe(404);
          expect(online.status, JSON.stringify(online.body)).toBe(200);
          expect(online.body).toEqual({ result: null });
          if (extraOnline) expect(results[2]).toEqual(online);
          const after = await readState(fixture, host, input.projectId);
          expect(after.scope).toMatchObject({
            projectId: input.projectId,
            rootDirectory: before.scope.rootDirectory,
            additionalDirectories: before.scope.additionalDirectories,
            generation: before.scope.generation + 1,
          });
          expect(after.snapshot.rows.window).toEqual(
            before.snapshot.rows.window,
          );
          const replay = await fixture.client.request("/api/code-ui/rpc", {
            ...observerInput,
            connectionId: closeFirst
              ? observer.ready.hello.connectionId
              : host.stream.ready.hello.connectionId,
          });
          expect(replay.status, JSON.stringify(replay.body)).toBe(200);
          expect(replay.body).toEqual(online.body);
          expect(await readState(fixture, host, input.projectId)).toEqual(
            after,
          );
          expect(model.requests).toEqual([]);
        } catch (error) {
          failures.push(error);
        } finally {
          for (const close of [
            () => blocker?.release(),
            () => first?.then(() => undefined),
            () => second?.then(() => undefined),
            () => third?.then(() => undefined),
            () => blocker?.close(),
            () => host?.dispose(),
            () => fixture.close(),
            () => model.close(),
          ]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length)
          throw new AggregateError(failures, "移动双连接验证或清理失败", {
            cause: failures[0],
          });
      },
      60_000,
    ); // 双可信连接与真实PG锁竞争的验证期限。
  },
);
