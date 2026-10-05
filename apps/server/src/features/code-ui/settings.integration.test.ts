import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeUiWorkspace } from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ProjectService } from "../projects/project-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

import { createCodeSessionFixture } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";
import { createHumanWorkspaceRpc } from "./workspace-rpc.js";

/** Only a disposable localhost cluster; no .env or existing DATABASE_URL. */
describe.skipIf(process.env.KENFUTWORK_SETTINGS_HOST_TEST_PG !== "1")(
  "原设置接口适配唯一Code偏好真实隔离Postgres",
  () => {
    it("归档排在在途设置之前时整条patch拒绝，显示叶子与目录快照不部分保存", async () => {
      const database = await createTaskWorkDatabase();
      const blocker = new Client({
        connectionString: database.connectionString,
      });
      const archiver = new Client({
        connectionString: database.connectionString,
      });
      let archival: Promise<unknown> | undefined;
      let update: Promise<unknown> | undefined;
      let inTransaction = false;
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        const instanceId = database.context.scope.instanceId;
        const projectId = database.context.scope.projectId;
        const rootDirectory = database.context.scope.rootDirectory;

        const actor = { instanceId: instanceId, accessClientId: null };
        const repository = createCodeUiRepository(database.persistence);
        const rpc = createHumanWorkspaceRpc({
          projects: {} as ProjectService,
          preferences: repository,
          instanceId: async () => instanceId,
          listWorkspaces: async () => {
            const projects = await database.persistence
              .forInstance(instanceId)
              .query<{
                id: string;
                name: string;
                work_dir: string;
              }>(
                "select id,name,work_dir from public.projects where instance_id=:instance and kind='code' and archived_at is null",
              );
            return projects.map(
              (project): CodeUiWorkspace => ({
                projectId: project.id,
                name: project.name,
                path: project.work_dir,
                additionalDirectories: [],
              }),
            );
          },
          maxEntries: async () => 5,
        });
        await rpc.call(actor, "setting", "update", [
          {
            locale: "zh-CN",
            recentProjects: [rootDirectory],
            lastWorkspaceSession: [
              { kind: "local", workspacePath: rootDirectory },
            ],
          },
        ]);
        const before = await repository.readHumanPreferences(instanceId);
        await blocker.connect();
        await archiver.connect();
        await blocker.query("begin");
        inTransaction = true;
        await blocker.query(
          "select id from public.projects where id=$1 for update",
          [projectId],
        );
        archival = archiver.query(
          "update public.projects set archived_at=now() where id=$1",
          [projectId],
        );
        const waiters = async () => {
          const locks = await blocker.query<{ count: string }>(
            "select count(distinct pid) from pg_locks where not granted and (transactionid=pg_current_xact_id()::text::xid or relation='public.projects'::regclass)",
          );
          return Number(locks.rows[0]?.count ?? 0);
        };
        await vi.waitFor(async () =>
          expect(await waiters()).toBeGreaterThanOrEqual(1),
        );
        let settled = false;
        update = rpc
          .call(actor, "setting", "update", [
            {
              locale: "en-US",
              messageStreamShowTodos: true,
              recentProjects: [rootDirectory],
              lastWorkspaceSession: [
                { kind: "local", workspacePath: rootDirectory },
              ],
            },
          ])
          .then(
            (value) => {
              settled = true;
              return { status: "fulfilled", value };
            },
            (reason: unknown) => {
              settled = true;
              return { status: "rejected", reason };
            },
          );
        await vi.waitFor(async () => {
          if (!settled) expect(await waiters()).toBeGreaterThanOrEqual(2);
        });
        await blocker.query("commit");
        inTransaction = false;
        await archival;
        expect(await update).toMatchObject({
          status: "rejected",
          reason: { code: "not_found" },
        });
        expect(await repository.readHumanPreferences(instanceId)).toEqual(
          before,
        );
        expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
          result: {
            recentProjects: [],
            lastWorkspaceSession: [],
            lastActiveTabIndex: 0,
          },
        });
      } finally {
        if (inTransaction) await blocker.query("rollback").catch(() => {});
        await Promise.allSettled([archival, update]);
        await Promise.allSettled([blocker.end(), archiver.end()]);
        await database.close();
      }
    });
  },
);

const isolatedHttp = useCodeUiHttpFixture();
const { request } = isolatedHttp;

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
const setting = (method: string, value?: unknown) =>
  request("/api/code-ui/rpc", {
    service: "setting",
    method,
    args: value === undefined ? [] : [value],
  });

describe.skipIf(!enabled)("原 Root 设置公开宿主 integration", () => {
  it("原语言、展示偏好与工作区 tab 快照稀疏保存后可重新读取，保持同一项目目录", async () => {
    const host = await createCodeSessionFixture("https://example.invalid/v1", {
      client: isolatedHttp,
    });
    try {
      const saved = await setting("update", {
        locale: "en-US",
        messageStreamShowTodos: true,
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: host.workspacePath,
            workspacePurpose: "project",
          },
        ],
        lastActiveTabIndex: 0,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await setting("get")).body.result).toMatchObject({
        locale: "en-US",
        messageStreamShowTodos: true,
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: host.workspacePath,
            workspacePurpose: "project",
          },
        ],
        lastActiveTabIndex: 0,
      });
      expect(
        (await setting("update", { messageStreamShowReasoning: false })).status,
      ).toBe(200);
      expect((await setting("get")).body.result).toMatchObject({
        locale: "en-US",
        messageStreamShowTodos: true,
        messageStreamShowReasoning: false,
      });
    } finally {
      await setting("update", {
        locale: "zh-CN",
        messageStreamShowTodos: false,
        messageStreamShowReasoning: true,
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
      });
      await host.dispose();
    }
  });
  it("不同显示偏好并发保存不丢叶子；最近目录与tab快照仍来自同一原工作区", async () => {
    const host = await createCodeSessionFixture("https://example.invalid/v1", {
      client: isolatedHttp,
    });
    try {
      const written = await Promise.all([
        setting("update", { locale: "en-US" }),
        setting("update", { messageStreamShowTodos: true }),
        setting("update", { messageStreamShowReasoning: false }),
      ]);
      expect(written.map((response) => response.status)).toEqual([
        200, 200, 200,
      ]);
      expect((await setting("get")).body.result).toMatchObject({
        locale: "en-US",
        messageStreamShowTodos: true,
        messageStreamShowReasoning: false,
      });
      expect(
        (
          await setting("update", {
            recentProjects: [host.workspacePath],
            lastWorkspaceSession: [
              { kind: "local", workspacePath: host.workspacePath },
            ],
            lastActiveTabIndex: 0,
          })
        ).status,
      ).toBe(200);
      expect((await setting("get")).body.result).toMatchObject({
        recentProjects: [host.workspacePath],
        lastWorkspaceSession: [
          { kind: "local", workspacePath: host.workspacePath },
        ],
      });
    } finally {
      await setting("update", {
        locale: "zh-CN",
        messageStreamShowTodos: false,
        messageStreamShowReasoning: true,
        recentProjects: [],
        lastWorkspaceSession: [],
      });
      await host.dispose();
    }
  });
  it("非法值、凭据及外部目录整条拒绝；归档后的tab保存不能复活目录", async () => {
    const host = await createCodeSessionFixture("https://example.invalid/v1", {
      client: isolatedHttp,
    });
    try {
      const before = (await setting("get")).body.result;
      for (const patch of [
        { locale: "invalid" },
        { apiKey: "integration-not-a-key" },
        { messageStreamShowTodos: "yes" },
      ]) {
        expect((await setting("update", patch)).status).toBe(400);
        expect((await setting("get")).body.result).toEqual(before);
      }
      expect(
        (
          await setting("update", {
            locale: "en-US",
            lastWorkspaceSession: [
              { kind: "local", workspacePath: "/不属于工作区的目录" },
            ],
          })
        ).status,
      ).toBe(404);
      expect((await setting("get")).body.result.locale).toBe(before.locale);
      expect(
        (await request(`/api/projects/${host.projectId}`, undefined, "DELETE"))
          .status,
      ).toBe(204);
      expect(
        (
          await setting("update", {
            locale: "en-US",
            lastWorkspaceSession: [
              { kind: "local", workspacePath: host.workspacePath },
            ],
          })
        ).status,
      ).toBe(404);
      expect((await setting("get")).body.result.locale).toBe(before.locale);
    } finally {
      await host.dispose();
    }
  });
  it("设置在途等待项目锁时先归档，迟到patch返回404且不部分保存", async () => {
    const host = await createCodeSessionFixture("https://example.invalid/v1", {
      client: isolatedHttp,
    });
    const delay = new Client({
      connectionString: isolatedHttp.databaseUrl(),
    });
    let archive: ReturnType<typeof request> | undefined;
    let update: ReturnType<typeof setting> | undefined;
    try {
      const before = (await setting("get")).body.result;
      await delay.connect();
      await delay.query("begin");
      // 独占测试库外部故障注入：让公开归档先排队，设置的FOR SHARE再等待同一项目。
      await delay.query(
        "select id from public.projects where id=$1 for update",
        [host.projectId],
      );
      const waitForBlocked = (count: number) =>
        vi.waitFor(async () => {
          const waiting = await delay.query(
            "select distinct pid from pg_locks where granted=false and (transactionid=pg_current_xact_id()::text::xid or relation='public.projects'::regclass)",
          );
          if (waiting.rows.length < count)
            throw new Error("等待公开请求到达项目延迟点");
        });
      archive = request(`/api/projects/${host.projectId}`, undefined, "DELETE");
      await waitForBlocked(1);
      update = setting("update", {
        locale: "en-US",
        recentProjects: [host.workspacePath],
        lastWorkspaceSession: [
          { kind: "local", workspacePath: host.workspacePath },
        ],
      });
      await waitForBlocked(2);
      await delay.query("commit");
      expect((await archive).status).toBe(204);
      const late = await update;
      expect(late.status, JSON.stringify(late.body)).toBe(404);
      const after = (await setting("get")).body.result;
      expect(after.locale).toBe(before.locale);
      expect(after.lastWorkspaceSession).toEqual(before.lastWorkspaceSession);
    } finally {
      await delay.query("rollback").catch(() => {});
      await delay.end();
      await Promise.all([archive, update]);
      await host.dispose();
    }
  });
  it("过滤归档tab时仍激活原目录，关联任务焦点不保留归档键", async () => {
    const hosts = await Promise.all(
      [1, 2, 3].map(() =>
        createCodeSessionFixture("https://example.invalid/v1", {
          client: isolatedHttp,
        }),
      ),
    );
    const [first, active, last] = hosts;
    if (!first || !active || !last) throw new Error("工作区夹具未建立");
    try {
      expect(
        (
          await setting("update", {
            lastWorkspaceSession: hosts.map((host) => ({
              kind: "local",
              workspacePath: host.workspacePath,
            })),
            lastActiveTabIndex: 1,
            lastActiveTaskByWorkspace: Object.fromEntries(
              hosts.map((host) => [host.workspacePath, host.sessionId]),
            ),
          })
        ).status,
      ).toBe(200);
      expect(
        (await request(`/api/projects/${first.projectId}`, undefined, "DELETE"))
          .status,
      ).toBe(204);
      expect((await setting("get")).body.result).toMatchObject({
        lastWorkspaceSession: [
          { kind: "local", workspacePath: active.workspacePath },
          { kind: "local", workspacePath: last.workspacePath },
        ],
        lastActiveTabIndex: 0,
        lastActiveTaskByWorkspace: {
          [JSON.stringify([active.projectId, active.workspacePath])]:
            active.sessionId,
          [JSON.stringify([last.projectId, last.workspacePath])]:
            last.sessionId,
        },
      });
      expect(
        (await setting("get")).body.result.lastActiveTaskByWorkspace[
          JSON.stringify([first.projectId, first.workspacePath])
        ],
      ).toBeUndefined();
    } finally {
      await setting("update", {
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
        lastActiveTaskByWorkspace: {},
      });
      await Promise.all(hosts.map((host) => host.dispose()));
    }
  });
  it("原recentProjects去重后保留前10项，关闭后重新读取保持原顺序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-ui-recent-normalization-"));
    const projects: string[] = [];
    const paths: string[] = [];
    try {
      for (let index = 0; index < 11; index += 1) {
        const path = join(dir, `目录${index}`);
        await mkdir(path);
        const opened = await request("/api/code-ui/rpc", {
          service: "workspace",
          method: "open",
          args: [{ path }],
        });
        expect(opened.status).toBe(200);
        projects.push(opened.body.result.projectId);
        paths.push(opened.body.result.path);
      }
      expect(
        (await setting("update", { recentProjects: [paths[0], ...paths] }))
          .status,
      ).toBe(200);
      expect((await setting("get")).body.result.recentProjects).toEqual(
        paths.slice(0, 10),
      );
    } finally {
      await setting("update", { recentProjects: [] });
      await Promise.all(
        projects.map((id) =>
          request(`/api/projects/${id}`, undefined, "DELETE"),
        ),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });
});
