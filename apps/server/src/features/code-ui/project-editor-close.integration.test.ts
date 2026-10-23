import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type HttpResult = Awaited<ReturnType<Fixture["client"]["request"]>>;

async function testFixture() {
  const model = await heldModel();
  try {
    return { fixture: await createCodeUiHttpFixture(), model };
  } catch (error) {
    await model.close();
    throw error;
  }
}

function rpc(
  fixture: Fixture,
  connectionId: string,
  method: string,
  args: unknown[] = [],
) {
  return fixture.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
    connectionId,
  });
}

async function readProject(fixture: Fixture, connectionId: string, id: string) {
  const response = await rpc(fixture, connectionId, "readProjects");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const project = response.body.result.find(
    (item: { id: string }) => item.id === id,
  );
  if (!project) throw new Error("原项目列表缺少当前项目");
  return project;
}

async function initializeObserver(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "project-close-integration",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  return stream;
}

async function backendPid(client: Client) {
  const result = await client.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error("隔离数据库连接未返回身份");
  return pid;
}

async function waitForLock(client: Client, blockerPid: number) {
  await expect
    .poll(async () => {
      await client.query("select pg_stat_clear_snapshot()");
      const blocked = await client.query(
        `select pid from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid()
            and state='active' and wait_event_type='Lock'
            and $1=any(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      return blocked.rows.length;
    })
    .toBe(1);
}

/** 真实文件句柄由原 Task 关闭贡献释放；PG 仅控制释放何时继续。 */
async function holdTaskFile(fixture: Fixture, host: Host) {
  const file = await open(
    join(host.workspacePath, "归档关闭中的文件.txt"),
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
    await blocker.connect();
    await cleanup.connect();
    const pid = await backendPid(blocker);
    await blocker.query("select pg_advisory_lock(hashtextextended($1,0))", [
      key,
    ]);
    lockHeld = true;
    unregister = fixture.app.kernel.get("capabilities").register<{
      close(instanceId: string, taskId: string): Promise<void>;
    }>("task-close", {
      id: `project-editor:file:${randomUUID()}`,
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
      waitBlocked: () => waitForLock(blocker, pid),
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

function createTask(host: Host, config: protocol.SessionConfigState) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: host.projectId,
          config: {
            modelSelection: config.modelSelection,
            mode: "build",
            planEnabled: false,
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目关闭与编辑连接 integration",
  () => {
    it("宿主关闭等待被取消的项目保存退出事务后完成", async () => {
      const { fixture, model } = await testFixture();
      const blocker = new Client({
        connectionString: fixture.database.connectionString,
      });
      let host: Host | undefined;
      let lockOpen = false;
      let saving: Promise<HttpResult> | undefined;
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const connectionId = host.stream.ready.hello.connectionId;
        const current = await readProject(
          fixture,
          connectionId,
          host.projectId,
        );
        const before = await host.client.request(
          `/api/projects/${host.projectId}`,
        );
        expect(before.status, JSON.stringify(before.body)).toBe(200);
        await blocker.connect();
        const pid = await backendPid(blocker);
        await blocker.query("begin");
        lockOpen = true;
        await blocker.query(
          "select id from public.projects where id=$1 for update",
          [host.projectId],
        );
        saving = rpc(fixture, connectionId, "saveProject", [
          {
            id: current.id,
            name: "关闭期间不得保存的名称",
            roots: current.roots.map(
              (root: { rootPath: string }) => root.rootPath,
            ),
            primaryRoot: host.workspacePath,
            rootPermissions: {},
            expectedRevision: current.revision,
          },
        ]);
        await waitForLock(blocker, pid);
        closing = fixture.app.kernel
          .get("codeUi")
          .closeConnections()
          .then(() => {
            closed = true;
          });
        const unavailable = await rpc(fixture, connectionId, "readProjects");
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(404);
        expect(closed).toBe(false);
        await blocker.query("commit");
        lockOpen = false;
        const rejected = await saving;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        await closing;
        expect(closed).toBe(true);
        const after = await host.client.request(
          `/api/projects/${host.projectId}`,
        );
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect(after.body.project).toEqual(before.body.project);
        expect(model.requests).toEqual([]);
      } finally {
        try {
          if (lockOpen) await blocker.query("rollback");
          await Promise.allSettled([saving, closing]);
        } finally {
          try {
            await blocker.end();
            await host?.dispose();
          } finally {
            try {
              await model.close();
            } finally {
              await fixture.close();
            }
          }
        }
      }
    }, 60_000); // 真实宿主关闭、在途事务和资源清理等待的测试期限。

    it("原归档服务等待真实Task文件关闭时拒绝创建新Task", async () => {
      const { fixture, model } = await testFixture();
      let host: Host | undefined;
      let resource: Awaited<ReturnType<typeof holdTaskFile>> | undefined;
      let archival: Promise<HttpResult> | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        resource = await holdTaskFile(fixture, host);
        archival = host.client.request(
          `/api/projects/${host.projectId}`,
          undefined,
          "DELETE",
        );
        await resource.waitBlocked();
        const created = await createTask(host, current.config);
        expect(created.status, JSON.stringify(created.body)).toBe(404);
        await resource.release();
        const archived = await archival;
        expect(archived.status, JSON.stringify(archived.body)).toBe(204);
        const unavailable = await host.client.request(
          `/api/projects/${host.projectId}`,
        );
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(404);
        expect(model.requests).toEqual([]);
      } finally {
        try {
          await resource?.release();
          await Promise.allSettled([archival]);
        } finally {
          try {
            await resource?.close();
            await host?.dispose();
          } finally {
            try {
              await model.close();
            } finally {
              await fixture.close();
            }
          }
        }
      }
    }, 60_000); // 真实归档、原生命周期贡献、PG锁及文件句柄关闭的测试期限。

    it("连接关闭使在途项目保存返回404且不写入，新连接可以正常保存", async () => {
      const { fixture, model } = await testFixture();
      const blocker = new Client({
        connectionString: fixture.database.connectionString,
      });
      let host: Host | undefined;
      let lockOpen = false;
      let saving: Promise<HttpResult> | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const observer = await initializeObserver(fixture);
        const connectionId = host.stream.ready.hello.connectionId;
        const observerId = observer.ready.hello.connectionId;
        const current = await readProject(
          fixture,
          connectionId,
          host.projectId,
        );
        const draft = {
          id: current.id,
          hostId: "local",
          name: "关闭前在途保存",
          roots: current.roots.map(
            (root: { rootPath: string }) => root.rootPath,
          ),
          primaryRoot: host.workspacePath,
          rootPermissions: {},
          expectedRevision: current.revision,
        };
        await blocker.connect();
        const pid = await backendPid(blocker);
        await blocker.query("begin");
        lockOpen = true;
        await blocker.query(
          "select id from public.projects where id=$1 for update",
          [host.projectId],
        );
        saving = rpc(fixture, connectionId, "saveProject", [draft]);
        await waitForLock(blocker, pid);
        host.stream.controller.abort();
        await host.stream.closed;
        // 等待服务端拒绝旧连接，避免把客户端 reader 退出当作宿主清理完成。
        await expect
          .poll(
            async () =>
              (await rpc(fixture, connectionId, "readProjects")).status,
          )
          .toBe(404);
        await blocker.query("commit");
        lockOpen = false;
        const rejected = await saving;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        expect(rejected.body.error.message).toContain("连接");
        expect(await readProject(fixture, observerId, host.projectId)).toEqual(
          current,
        );
        const saved = await rpc(fixture, observerId, "saveProject", [
          { ...draft, name: "重连后保存" },
        ]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result).toMatchObject({
          id: current.id,
          name: "重连后保存",
          revision: current.revision + 1,
        });
        expect(await readProject(fixture, observerId, host.projectId)).toEqual(
          saved.body.result,
        );
        expect(model.requests).toEqual([]);
      } finally {
        try {
          if (lockOpen) await blocker.query("rollback");
          await Promise.allSettled([saving]);
        } finally {
          try {
            await blocker.end();
            await host?.dispose();
          } finally {
            try {
              await model.close();
            } finally {
              await fixture.close();
            }
          }
        }
      }
    }, 60_000); // 真实HTTP/SSE连接关闭、PG等待与重连保存的测试期限。
  },
);
