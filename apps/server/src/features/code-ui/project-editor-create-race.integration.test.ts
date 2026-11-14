import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type SessionFixture = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type HttpResult = Awaited<ReturnType<SessionFixture["client"]["request"]>>;

async function project(host: SessionFixture) {
  const response = await host.client.request(`/api/projects/${host.projectId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.project;
}

async function scope(host: SessionFixture, taskId: string) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

function createTask(
  host: SessionFixture,
  modelSelection: protocol.SessionConfigState["modelSelection"],
) {
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
          config: { modelSelection, mode: "build", planEnabled: false },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
}

function acceptedTask(response: HttpResult): string {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
  const sessionId = response.body.result.result.sessionId;
  if (typeof sessionId !== "string")
    throw new Error("新Task接纳未返回任务身份");
  return sessionId;
}

async function waitForProjectLock(client: Client, excluded: number[] = []) {
  let pid: number | undefined;
  await expect
    .poll(async () => {
      await client.query("select pg_stat_clear_snapshot()");
      const blocked = await client.query<{ pid: number }>(
        `select pid from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid()
            and state='active' and wait_event_type='Lock'
            and query ilike '%public.projects%'
            and not(pid=any($1::integer[]))`,
        [excluded],
      );
      pid = blocked.rows[0]?.pid;
      return blocked.rows.length;
    })
    .toBe(1);
  if (pid === undefined) throw new Error("项目行锁等待没有返回连接身份");
  return pid;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "项目编辑与新Task创建竞争 integration",
  () => {
    it("项目保存先提交时并发新Task使用当前目录，已有Task保留原目录权限", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "code-project-create-race-")),
      );
      const model = await heldModel();
      let host: SessionFixture | undefined;
      let lock: Client | undefined;
      let lockOpen = false;
      let saving: Promise<HttpResult> | undefined;
      let creating: Promise<HttpResult> | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const selection = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        ).config.modelSelection;
        const configured = await host.client.request(
          `/api/projects/${host.projectId}`,
          {
            additional_directories: [{ path: directory, access: "read-write" }],
          },
          "PATCH",
        );
        expect(configured.status, JSON.stringify(configured.body)).toBe(204);
        const previousTaskId = acceptedTask(await createTask(host, selection));
        const previousScope = await scope(host, previousTaskId);
        expect(previousScope.additionalDirectories).toEqual([
          { path: directory, access: "read-write" },
        ]);
        const current = await project(host);
        lock = new Client({ connectionString: isolatedHttp.databaseUrl() });
        await lock.connect();
        await lock.query("begin");
        lockOpen = true;
        await lock.query(
          "select id from public.projects where id=$1 for update",
          [host.projectId],
        );
        saving = host.client.request(
          `/api/projects/${host.projectId}`,
          { additional_directories: [] },
          "PATCH",
        );
        const savingPid = await waitForProjectLock(lock);
        creating = createTask(host, selection);
        await waitForProjectLock(lock, [savingPid]);
        await lock.query("commit");
        lockOpen = false;
        const saved = await saving;
        expect(saved.status, JSON.stringify(saved.body)).toBe(204);
        const taskId = acceptedTask(await creating);
        expect(taskId).not.toBe(previousTaskId);
        expect((await scope(host, taskId)).additionalDirectories).toEqual([]);
        expect(await scope(host, previousTaskId)).toEqual(previousScope);
        expect(await project(host)).toMatchObject({
          id: current.id,
          name: current.name,
          work_dir: current.work_dir,
          additional_directories: [],
        });
        expect(model.requests).toEqual([]);
      } finally {
        try {
          if (lockOpen) await lock?.query("rollback");
          await Promise.allSettled([saving, creating]);
        } finally {
          try {
            await lock?.end();
            await host?.dispose();
          } finally {
            await model.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }, 60_000); // 真实HTTP与PostgreSQL行锁编排的测试期限。
  },
);
