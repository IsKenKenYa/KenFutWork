import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  ensurePgmqAvailable,
  resolvePgmqShimDir,
} from "../../desktop/pgmq-shim.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import {
  applyMigrations,
  loadMigrationSet,
  readLedger,
  type SqlQueryable,
} from "../persistence/migrations.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTemporaryPostgres } from "../task-work/test-postgres.js";

/** 显式临时集群回归，不读取 DATABASE_URL/.env，不连接或清理开发库。
 * RUN_LOCAL_INSTANCE_SCHEMA_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/local-instance/schema.integration.test.ts
 */
describe.skipIf(process.env.RUN_LOCAL_INSTANCE_SCHEMA_INTEGRATION !== "1")(
  "本地实例最终 Schema",
  () => {
    it("完整历史重放、清理目录、真实 DAO/CAS 与二次 no-op", async () => {
      const database = await createTemporaryPostgres();
      const client = new Client({
        connectionString: database.connectionString,
      });
      let persistence: ReturnType<typeof createPostgresPersistence> | undefined;
      try {
        await client.connect();
        const root = fileURLToPath(new URL("../../../../../", import.meta.url));
        await ensurePgmqAvailable(client, {
          binDir: database.binDir,
          shimDir: resolvePgmqShimDir({ env: {}, repoRoot: root }),
        });
        const files = loadMigrationSet({
          bootstrapDir: join(root, "supabase/bootstrap"),
          migrationsDir: join(root, "supabase/migrations"),
        });
        const cleanup = files.find(
          (file) => file.name === "local_instance_schema",
        );
        if (!cleanup) throw new Error("本地实例清理迁移未登记。");
        const queryable: SqlQueryable = {
          async query<T = Record<string, unknown>>(
            text: string,
            values?: unknown[],
          ) {
            const result = await client.query(text, values);
            return { rowCount: result.rowCount, rows: result.rows as T[] };
          },
        };
        const historical = files.filter(
          (file) => file.version < cleanup.version,
        );
        const first = await applyMigrations(queryable, historical);
        expect(first.applied).toHaveLength(historical.length);

        // 证明业务测试数据允许丢弃，但已确定实例与接入凭据不能随清理丢失。
        const instanceId = randomUUID();
        const accessClientId = randomUUID();
        const oldAccountId = randomUUID();
        await client.query(
          "insert into public.local_instances(id) values($1)",
          [instanceId],
        );
        await client.query(
          "insert into public.local_access_clients(id,instance_id,kind,label,token_hash) values($1,$2,'api','迁移回归',$3)",
          [accessClientId, instanceId, "a".repeat(64)],
        );
        await client.query(
          "insert into public.accounts(id,email) values($1,'schema-fixture@integration.local')",
          [oldAccountId],
        );
        await client.query(
          "insert into public.workspaces(id,type,name,owner_user_id) values($1,'personal','旧测试数据',$2)",
          [randomUUID(), oldAccountId],
        );
        const final = await applyMigrations(queryable, files);
        expect(final.applied).toContain(cleanup.version);
        const ledger = await readLedger(queryable);
        expect(ledger.map((entry) => [entry.version, entry.checksum])).toEqual(
          files.map((file) => [file.version, file.checksum]),
        );
        expect((await applyMigrations(queryable, files)).applied).toEqual([]);
        expect(
          (await client.query("select id from public.local_instances")).rows,
        ).toEqual([{ id: instanceId }]);
        expect(
          (
            await client.query(
              "select id,instance_id from public.local_access_clients",
            )
          ).rows,
        ).toEqual([{ id: accessClientId, instance_id: instanceId }]);

        const retired = [
          "accounts",
          "account_credentials",
          "account_sessions",
          "profiles",
          "workspace_members",
          "workspaces",
          "workspace_settings",
          "workspace_skills",
          "subscriptions",
          "credit_balances",
          "credit_transactions",
          "daily_credit_claims",
          "payment_events",
          "flow_credit_holds",
          "api_tokens",
        ];
        const remaining = await client.query<{
          name: string;
          relation: string | null;
        }>(
          "select name, to_regclass('public.' || name)::text as relation from unnest($1::text[]) as name",
          [retired],
        );
        expect(remaining.rows.filter((row) => row.relation !== null)).toEqual(
          [],
        );
        expect(
          (
            await client.query(
              "select to_regclass('auth.users') as identity_view",
            )
          ).rows[0]?.identity_view,
        ).toBeNull();
        const oldFields = await client.query<{
          table_name: string;
          column_name: string;
        }>(
          "select table_name,column_name from information_schema.columns where table_schema='public' and column_name = any($1::text[])",
          [
            [
              "workspace_id",
              "user_id",
              "owner_user_id",
              "created_by",
              "installed_by",
              "encrypted_api_key",
              "value_ciphertext",
              "credits_cost",
              "credits_transaction_id",
              "legacy_canvas_id",
            ],
          ],
        );
        expect(oldFields.rows).toEqual([]);
        const oldTypes = await client.query(
          "select typname from pg_type where typnamespace='public'::regnamespace and typname=any($1::text[])",
          [
            [
              "workspace_type",
              "workspace_member_role",
              "subscription_plan",
              "billing_period",
              "credit_transaction_type",
            ],
          ],
        );
        expect(oldTypes.rows).toEqual([]);
        const publicFunctions = await client.query<{
          proname: string;
          prosrc: string;
        }>(
          "select p.proname,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')",
        );
        for (const row of publicFunctions.rows)
          expect(row.prosrc).not.toMatch(
            /public\.(accounts|profiles|workspaces|workspace_members|subscriptions|credit_balances|credit_transactions|daily_credit_claims|payment_events|flow_credit_holds)|workspace_id|user_id|encrypted_api_key|value_ciphertext|auth\.uid/i,
          );
        const scopedTables = await client.query<{ table_name: string }>(
          "select table_name from information_schema.columns where table_schema='public' and column_name='instance_id' order by table_name",
        );
        const linkedTables = await client.query<{ table_name: string }>(
          "select distinct r.relname as table_name from pg_constraint fk join pg_class r on r.oid=fk.conrelid join pg_attribute a on a.attrelid=r.oid and a.attname='instance_id' where fk.contype='f' and fk.confrelid='public.local_instances'::regclass and fk.conkey=array[a.attnum]::smallint[] order by r.relname",
        );
        expect(linkedTables.rows).toEqual(scopedTables.rows);
        const auditColumns = await client.query<{
          attnotnull: boolean;
          reference: string;
          confdeltype: string;
        }>(
          "select a.attnotnull,c.confrelid::regclass::text as reference,c.confdeltype from pg_attribute a join pg_class r on r.oid=a.attrelid join pg_namespace n on n.oid=r.relnamespace join pg_constraint c on c.conrelid=r.oid and c.conkey=array[a.attnum]::smallint[] and c.contype='f' where n.nspname='public' and a.attname in ('created_by_client_id','installed_by_client_id','access_client_id')",
        );
        expect(auditColumns.rows.length).toBeGreaterThan(0);
        for (const row of auditColumns.rows)
          expect(row).toEqual({
            attnotnull: false,
            reference: "local_access_clients",
            confdeltype: "n",
          });
        const lineage = await client.query<{ definition: string }>(
          "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('public.code_ui_sessions'::regclass,'public.task_works'::regclass,'public.agent_turn_boundaries'::regclass)",
        );
        for (const required of [
          "FOREIGN KEY (root_session_id)",
          "FOREIGN KEY (parent_session_id)",
          "FOREIGN KEY (task_id, instance_id)",
          "UNIQUE (instance_id, task_id, branch_generation, origin_run_id, tool_call_id)",
          "scope_generation >= 0",
          "branch_generation >= 1",
        ])
          expect(
            lineage.rows.some((row) => row.definition.includes(required)),
            required,
          ).toBe(true);
        expect(
          (
            await client.query(
              "select to_regnamespace('langgraph') as namespace",
            )
          ).rows[0]?.namespace,
        ).toBe("langgraph");
        expect(
          (await client.query("select to_regnamespace('pgmq') as namespace"))
            .rows[0]?.namespace,
        ).toBe("pgmq");

        persistence = createPostgresPersistence({
          databaseUrl: database.connectionString,
        });
        const directory = join(database.directory, "project");
        await mkdir(directory);
        const projects = createProjectRepository(persistence);
        const code = await projects.createProject({
          instanceId,
          createdByClientId: accessClientId,
          kind: "code",
          name: "本地 Code",
          slug: "local-code",
          description: null,
          canvasName: "不创建画布",
          workDir: directory,
        });
        expect(code.canvas).toBeNull();
        const design = await projects.createProject({
          instanceId,
          createdByClientId: null,
          kind: "design",
          name: "本地 Design",
          slug: "local-design",
          description: null,
          canvasName: "主画布",
        });
        expect(design.canvas?.id).toBeTruthy();
        const taskId = randomUUID();
        const tasks = createCodeUiRepository(persistence);
        await tasks.createRoot(instanceId, {
          sessionId: taskId,
          projectId: code.project.id,
          createdByClientId: accessClientId,
          threadId: "schema-test-thread",
          scope: {
            instanceId,
            projectId: code.project.id,
            taskId,
            generation: 1,
            rootDirectory: directory,
            additionalDirectories: [],
            sandboxMode: "workspace-write",
          },
          state: createCodeUiConversation({
            sessionId: taskId,
            workspacePath: directory,
            config: { provider: "zcode", model: "schema-test", thought: "", followupMode: "queue" },
          }).exportState(),
          command: {
            clientId: "original-sdk-client",
            commandId: "create-schema-task",
            fingerprint: "schema-task",
          },
        });
        const rootTask = await tasks.find(instanceId, taskId);
        expect(rootTask).toMatchObject({
          id: taskId,
          instance_id: instanceId,
          project_id: code.project.id,
          root_directory: directory,
          scope_generation: "1",
          branch_generation: "1",
        });
        expect(
          (await tasks.list(instanceId, code.project.id)).map(
            (task) => task.id,
          ),
        ).toEqual([taskId]);
        expect(
          (await tasks.listRoots(instanceId)).map((task) => task.id),
        ).toEqual([taskId]);
        const unrelatedTask = randomUUID();
        await expect(
          client.query(
            "insert into public.code_ui_sessions(id,instance_id,project_id,root_session_id,parent_session_id,execution_state) values($1,$2,$3,$4,$4,'failed')",
            [unrelatedTask, instanceId, code.project.id, randomUUID()],
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          client.query(
            "update public.code_ui_sessions set branch_generation=0 where id=$1",
            [taskId],
          ),
        ).rejects.toMatchObject({ code: "23514" });

        const providers = createModelProviderRepository(persistence);
        const providerId = randomUUID();
        const provider = await providers.insertInstance({
          id: providerId,
          instanceId,
          name: "本地供应商",
          protocol: "openai-compatible",
          apiKeyRef: providerId,
          models: [{ id: "test-model", name: "test", capability: "chat" }],
          enabled: true,
        });
        if (!provider) throw new Error("供应商 DAO 没有返回创建行。");
        const revision = async () =>
          Number(
            (
              await client.query(
                "select revision from public.provider_registry_revisions where instance_id=$1",
                [instanceId],
              )
            ).rows[0]?.revision,
          );
        expect(await revision()).toBe(1);
        await providers.setProbeResult(instanceId, providerId, {
          reachable: true,
        });
        expect(await revision()).toBe(1);
        const changed = await providers.updateInstance(
          instanceId,
          providerId,
          { name: "修改供应商" },
          Number(provider.config_revision),
        );
        if (!changed) throw new Error("供应商配置更新失败。");
        expect(await revision()).toBe(2);
        const same = await providers.updateInstance(
          instanceId,
          providerId,
          { name: "修改供应商" },
          Number(changed.config_revision),
        );
        expect(same?.name).toBe("修改供应商");
        expect(await revision()).toBe(2);
        expect(
          await providers.updateInstance(
            instanceId,
            providerId,
            { name: "旧修订不准写" },
            Number(provider.config_revision),
          ),
        ).toBeNull();
        expect(await revision()).toBe(2);
        await client.query(
          "update public.provider_instances set credential_revision=credential_revision+1,config_revision=config_revision+1 where id=$1",
          [providerId],
        );
        expect(await revision()).toBe(3);
        await providers.deleteInstance(instanceId, providerId);
        expect(await revision()).toBe(4);

        // 客户端撤销/删除不会删除项目；审计引用释放后，稳定实例归属保持不变。
        await client.query(
          "delete from public.local_access_clients where id=$1",
          [accessClientId],
        );
        expect(
          (
            await client.query(
              "select instance_id,created_by_client_id from public.projects where id=$1",
              [code.project.id],
            )
          ).rows[0],
        ).toEqual({ instance_id: instanceId, created_by_client_id: null });
        expect((await applyMigrations(queryable, files)).applied).toEqual([]);
      } finally {
        await persistence?.close();
        await client.end();
        await database.close();
      }
    }, 120_000);
  },
);
