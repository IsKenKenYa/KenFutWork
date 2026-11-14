import { randomUUID } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskProjectMoveInput,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type CloseKind = "connection" | "host";

function projectRpc(
  fixture: Fixture,
  host: Host,
  method: string,
  args: unknown[],
) {
  return fixture.client.request("/api/code-ui/rpc", {
    connectionId: host.stream.ready.hello.connectionId,
    service: "project",
    method,
    args,
  });
}

async function readState(
  fixture: Fixture,
  host: Host,
  targetProjectId: string,
) {
  const responses = await Promise.all([
    fixture.client.request(`/api/code-ui/tasks/${host.sessionId}/scope`),
    fixture.client.request(`/api/code-ui/sessions/${host.sessionId}`),
    fixture.client.request(`/api/projects/${host.projectId}`),
    fixture.client.request(`/api/projects/${targetProjectId}`),
  ]);
  for (const response of responses)
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  const [scope, session, source, target] = responses;
  if (!scope || !session || !source || !target)
    throw new Error("移动验证缺少完整公开读取结果。");
  return {
    scope: codeTaskScopeResponseSchema.parse(scope.body).scope,
    snapshot: protocol.conversationSnapshotSchema.parse(session.body.snapshot),
    source: source.body.project,
    target: target.body.project,
  };
}

async function createTarget(fixture: Fixture) {
  const root = join(fixture.directory, "接纳后关闭的目标目录");
  const additional = join(fixture.directory, "目标项目可写目录");
  await mkdir(root);
  await mkdir(additional);
  const response = await fixture.client.request("/api/projects", {
    name: "接纳后关闭的目标项目",
    kind: "code",
    work_dir: root,
    additional_directories: [{ path: additional, access: "read-write" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectCreateResponseSchema.parse(response.body).project;
}

async function prepareTaskPermissions(fixture: Fixture, host: Host) {
  const additional = join(fixture.directory, "移动保留的Task只读目录");
  await mkdir(additional);
  const canonicalAdditional = await realpath(additional);
  const response = await fixture.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    {
      additionalDirectories: [
        { path: canonicalAdditional, access: "read-only" },
      ],
      sandboxMode: "workspace-write",
    },
    "PATCH",
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(codeTaskScopeResponseSchema.parse(response.body).scope).toMatchObject({
    projectId: host.projectId,
    taskId: host.sessionId,
    rootDirectory: host.workspacePath,
    additionalDirectories: [{ path: canonicalAdditional, access: "read-only" }],
    sandboxMode: "workspace-write",
  });
}

async function startGoal(host: Host) {
  const before = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(before.goal).toBeNull();
  if (!before.taskControl) throw new Error("移动测试缺少公开Task控制观察值。");
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      projectId: host.projectId,
      goalControl: { expectedGoal: null },
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: host.sessionId,
        type: "sendGoalCommand",
        payload: { text: "移动接纳后关闭仍保留的暂停目标" },
        taskControl: before.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
}

async function pauseGoal(fixture: Fixture, host: Host, model: Model) {
  await startGoal(host);
  await model.firstRequest;
  const body = "移动前已通过模型HTTP保存的正文";
  model.writeText(0, body);
  await vi.waitFor(
    async () => {
      const response = await fixture.client.request(
        `/api/code-ui/sessions/${host.sessionId}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const snapshot = protocol.conversationSnapshotSchema.parse(
        response.body.snapshot,
      );
      expect(JSON.stringify(snapshot.rows.window)).toContain(body);
    },
    { timeout: 30_000 },
  ); // 只等待本例受控模型HTTP的真实输出进入公开历史。
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(
    async () => {
      const response = await fixture.client.request(
        `/api/code-ui/sessions/${host.sessionId}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const snapshot = protocol.conversationSnapshotSchema.parse(
        response.body.snapshot,
      );
      expect(snapshot.control).toMatchObject({
        phase: "completedInterrupted",
        stopState: "idle",
        activeWorks: [],
      });
      expect(snapshot.pendingInteractions).toEqual([]);
      expect(snapshot.pendingCommands).toEqual([]);
      expect(snapshot.goal).toMatchObject({
        objective: "移动接纳后关闭仍保留的暂停目标",
        status: "paused",
      });
      expect(JSON.stringify(snapshot.rows.window)).toContain(body);
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  ); // 只读等待原停止完成、目标暂停及实际模型连接关闭。
}

async function backendPid(client: Client) {
  const result = await client.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error("隔离数据库连接缺少进程身份。");
  return pid;
}

/** 关闭贡献到达时，移动准备事务已经返回；PG锁只延迟真实文件句柄关闭。 */
async function holdTaskFile(fixture: Fixture, host: Host) {
  const file = await open(
    join(host.workspacePath, "移动接纳后关闭的文件.txt"),
    "w",
  );
  const blocker = new Client({
    connectionString: fixture.database.connectionString,
  });
  const cleanup = new Client({
    connectionString: fixture.database.connectionString,
  });
  const key = randomUUID();
  let lockHeld = false;
  let unregister: (() => void) | undefined;
  try {
    await file.writeFile("等待原Task关闭贡献释放的文件\n", "utf8");
    await blocker.connect();
    await cleanup.connect();
    const blockerPid = await backendPid(blocker);
    const cleanupPid = await backendPid(cleanup);
    await blocker.query("select pg_advisory_lock(hashtextextended($1,0))", [
      key,
    ]);
    lockHeld = true;
    unregister = fixture.app.kernel.get("capabilities").register<{
      close(instanceId: string, taskId: string): Promise<void>;
    }>("task-close", {
      id: `project-move-admitted:file:${randomUUID()}`,
      value: {
        async close(instanceId, taskId) {
          if (
            instanceId !== fixture.actor.instanceId ||
            taskId !== host.sessionId
          )
            return;
          await cleanup.query(
            "select pg_advisory_xact_lock(hashtextextended($1,0))",
            [key],
          );
          await file.close();
        },
      },
    });
    const release = async () => {
      if (!lockHeld) return;
      await blocker.query("select pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
      lockHeld = false;
    };
    return {
      release,
      isClosed: () => file.fd === -1,
      async waitAdmitted() {
        await expect
          .poll(async () => {
            await blocker.query("select pg_stat_clear_snapshot()");
            const waiting = await blocker.query(
              `select pid from pg_stat_activity
               where datname=current_database() and pid=$2
                 and state='active' and wait_event_type='Lock'
                 and $1=any(pg_blocking_pids(pid))`,
              [blockerPid, cleanupPid],
            );
            return waiting.rows.length;
          })
          .toBe(1);
      },
      async close() {
        try {
          await release();
        } finally {
          unregister?.();
          try {
            await file.close();
          } finally {
            await cleanup.end();
            await blocker.end();
          }
        }
      },
    };
  } catch (error) {
    unregister?.();
    await file.close();
    await cleanup.end();
    await blocker.end();
    throw error;
  }
}

async function waitConnectionClosed(fixture: Fixture, host: Host) {
  await expect
    .poll(async () => {
      const response = await projectRpc(fixture, host, "readTree", [
        { hostId: "local" },
      ]);
      if (response.status === 404)
        applicationErrorResponseSchema.parse(response.body);
      return response.status;
    })
    .toBe(404);
}

async function closeInitiator(fixture: Fixture, host: Host, kind: CloseKind) {
  if (kind === "connection") {
    host.stream.controller.abort();
    await host.stream.closed;
    // 先用公开只读请求确认SSE关闭已被服务端接收，再等待其已登记的资源清理。
    await waitConnectionClosed(fixture, host);
  }
  let closed = false;
  const closing = fixture.app.kernel
    .get("codeUi")
    .closeConnections()
    .then(() => {
      closed = true;
    });
  return { closing, isClosed: () => closed };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task移动准备已接纳后的真实HTTP、SSE与文件关闭 integration",
  () => {
    it.each([
      ["发起SSE连接关闭", "connection"],
      ["Code通知宿主关闭", "host"],
    ] as const)(
      "%s等待文件贡献退出，完成归属更新并保持Task权限与暂停Goal",
      async (_label, kind) => {
        const model = await heldModel();
        let fixture: Fixture | undefined;
        let host: Host | undefined;
        let resource: Awaited<ReturnType<typeof holdTaskFile>> | undefined;
        let moving: ReturnType<typeof projectRpc> | undefined;
        let closing: Promise<void> | undefined;
        let moveSettled = false;
        const failures: unknown[] = [];
        try {
          fixture = await createCodeUiHttpFixture();
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          await prepareTaskPermissions(fixture, host);
          await pauseGoal(fixture, host, model);
          const target = await createTarget(fixture);
          const before = await readState(fixture, host, target.id);
          if (!before.snapshot.taskControl || !before.snapshot.goal)
            throw new Error("真实移动材料缺少Task控制或暂停目标。");
          expect(before.snapshot.goal.status).toBe("paused");
          const modelRequestCountBefore = model.requests.length;
          const input: CodeTaskProjectMoveInput = {
            task: {
              taskId: host.sessionId,
              workspacePath: before.scope.rootDirectory,
              workspaceIdentity: JSON.stringify([
                host.projectId,
                before.scope.rootDirectory,
              ]),
            },
            hostId: "local",
            sourceProjectId: host.projectId,
            projectId: target.id,
            observedRevision: before.snapshot.revision,
            addMissingRoot: true,
          };
          resource = await holdTaskFile(fixture, host);
          moving = projectRpc(fixture, host, "moveTask", [input]).then(
            (response) => {
              moveSettled = true;
              return response;
            },
            (error: unknown) => {
              moveSettled = true;
              throw error;
            },
          );
          await resource.waitAdmitted();
          expect(resource.isClosed()).toBe(false);
          expect(moveSettled).toBe(false);
          const initiated = await closeInitiator(fixture, host, kind);
          closing = initiated.closing;
          await waitConnectionClosed(fixture, host);
          expect(initiated.isClosed()).toBe(false);
          expect(resource.isClosed()).toBe(false);
          expect(moveSettled).toBe(false);
          await resource.release();
          const response = await moving;
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          expect(
            applicationErrorResponseSchema.parse(response.body).error.message,
          ).toContain("连接");
          await closing;
          expect(initiated.isClosed()).toBe(true);
          expect(resource.isClosed()).toBe(true);
          const after = await readState(fixture, host, target.id);
          expect(after.scope).toEqual({
            ...before.scope,
            projectId: target.id,
            generation: before.scope.generation + 1,
          });
          expect(after.snapshot.rows.window).toEqual(
            before.snapshot.rows.window,
          );
          expect(after.snapshot.goal).toEqual(before.snapshot.goal);
          expect(after.snapshot.control.phase).toBe(
            before.snapshot.control.phase,
          );
          expect(after.snapshot.taskControl).toEqual({
            ...before.snapshot.taskControl,
            projectId: target.id,
            branchGeneration: before.snapshot.taskControl.branchGeneration + 1,
          });
          expect(after.snapshot.revision).toBeGreaterThan(
            before.snapshot.revision,
          );
          expect(after.source).toEqual(before.source);
          expect(after.target).toMatchObject({
            id: target.id,
            name: before.target.name,
            work_dir: before.target.work_dir,
            additional_directories: [
              ...before.target.additional_directories,
              { path: before.scope.rootDirectory, access: "read-write" },
            ],
          });
          expect(model.requests).toHaveLength(modelRequestCountBefore);
        } catch (error) {
          failures.push(error);
        } finally {
          for (const close of [
            () => resource?.release(),
            () => moving?.then(() => undefined),
            () => closing,
            () => resource?.close(),
            () => host?.dispose(),
            () => fixture?.close(),
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
          throw new AggregateError(
            failures,
            "已接纳移动关闭验证或资源释放失败",
            { cause: failures[0] },
          );
      },
      90_000,
    ); // 原准备接纳、真实文件关闭贡献、HTTP/SSE/PG及模型连接的验证期限。
  },
);
