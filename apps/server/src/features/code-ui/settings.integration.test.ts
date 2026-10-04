import type { CodeUiWorkspace } from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ProjectService } from "../projects/project-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
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
        const workspaceId = database.context.scope.workspaceId;
        const projectId = database.context.scope.projectId;
        const rootDirectory = database.context.scope.rootDirectory;
        const owner = await database.persistence.queryOne<{
          owner_user_id: string;
        }>("select owner_user_id from public.workspaces where id=$1", [
          workspaceId,
        ]);
        if (!owner) throw new Error("隔离工作区不存在。");
        const actor = {
          id: owner.owner_user_id,
          email: "settings@integration.test",
          accessToken: "private-test",
          userMetadata: {},
        };
        const repository = createCodeUiRepository(database.persistence);
        const rpc = createHumanWorkspaceRpc({
          projects: {} as ProjectService,
          preferences: repository,
          workspaceId: async () => workspaceId,
          listWorkspaces: async () => {
            const projects = await database.persistence
              .forWorkspace(workspaceId)
              .query<{
                id: string;
                name: string;
                work_dir: string;
              }>(
                "select id,name,work_dir from public.projects where workspace_id=:workspace and kind='code' and archived_at is null",
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
        const before = await repository.readHumanPreferences(workspaceId);
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
        expect(await repository.readHumanPreferences(workspaceId)).toEqual(
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
