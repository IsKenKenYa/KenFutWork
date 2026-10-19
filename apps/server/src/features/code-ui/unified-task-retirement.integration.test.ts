import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createCanvasRepository } from "../canvas/repository.js";
import {
  applyMigrations,
  loadMigrationSet,
} from "../persistence/migrations.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "旧Design执行退役迁移 integration",
  () => {
    it("取消可运行/重试旧Jobs，保留成功成果、Code/共享Task/无会话Jobs及全部审计身份；重放不递增代际", async () => {
      const db = await createTaskWorkDatabase({
        stopAtMigration: "20261015090000",
      });
      const client = new Client({ connectionString: db.connectionString });
      try {
        await client.connect();
        const sql = db.persistence.forInstance(db.instanceId);
        const { projectId, taskId, rootDirectory } = db.context.scope;
        await sql.execute(
          "update public.projects set enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
          [projectId],
        );
        const canvas = await createCanvasRepository(db.persistence).create({
          instanceId: db.instanceId,
          projectId,
          canvasId: randomUUID(),
          name: "保留文档",
        });
        if (!canvas) throw new Error("迁移夹具文档创建失败");
        const legacyTaskId = randomUUID();
        const sharedTaskId = randomUUID();
        for (const [id, mode] of [
          [legacyTaskId, "design"],
          [taskId, "code"],
          [sharedTaskId, "design"],
        ] as const) {
          await sql.execute(
            "insert into public.chat_sessions(id,instance_id,project_id,mode,canvas_id,created_by_client_id,thread_id) values($1,:instance,$2,$3,$4,$5,$6)",
            [
              id,
              projectId,
              mode,
              mode === "design" ? canvas.id : null,
              db.actor.accessClientId,
              `retirement:${id}`,
            ],
          );
        }
        await sql.execute(
          "insert into public.code_ui_sessions(id,instance_id,project_id,root_session_id,root_directory) values($1,:instance,$2,$1,$3)",
          [sharedTaskId, projectId, rootDirectory],
        );
        await sql.execute(
          "insert into public.design_task_executions(task_id,instance_id,project_id,root_directory,active_run_id,runtime_owner_id,run_state) values($1,:instance,$2,$3,'old-run',$4,'running')",
          [legacyTaskId, projectId, rootDirectory, randomUUID()],
        );
        await sql.execute(
          "insert into public.execution_task_owners(instance_id,task_id,project_id,task_kind,design_task_id) values(:instance,$1,$2,'design',$1)",
          [legacyTaskId, projectId],
        );
        await sql.execute(
          "insert into public.design_task_inputs(task_id,instance_id,input_id,run_id,admission_seq,scope_generation,branch_generation,request,fingerprint,status) values($1,:instance,'old-input','old-run',1,1,1,'{}'::jsonb,'audit-fingerprint','running')",
          [legacyTaskId],
        );
        await sql.execute(
          "insert into public.design_task_goals(task_id,instance_id,project_id,state,owner_client_id) values($1,:instance,$2,$3::jsonb,$4)",
          [
            legacyTaskId,
            projectId,
            JSON.stringify({
              status: "active",
              revision: 3,
              claimedRunId: "old-run",
              evaluation: { state: "inflight" },
              objective: "保留审计目标",
            }),
            db.actor.accessClientId,
          ],
        );
        const workId = randomUUID();
        await sql.execute(
          "insert into public.task_works(id,instance_id,project_id,task_id,owner_kind,scope,agent_id,kind,label,origin_run_id,tool_call_id,parameter_fingerprint,branch_generation,status,started_at,owner_id,execution_host_id) values($1,:instance,$2,$3,'design',$4::jsonb,'main','command','保留审计','old-run','old-call','old-fingerprint',1,'running',now(),$5,'retired-host')",
          [
            workId,
            projectId,
            legacyTaskId,
            JSON.stringify({ ...db.context.scope, taskId: legacyTaskId }),
            randomUUID(),
          ],
        );
        const jobs: Array<{
          id: string;
          sessionId: string | null;
          status: string;
          shouldRetire: boolean;
        }> = [
          ...[
            "queued",
            "running",
            "failed",
            "succeeded",
            "canceled",
            "dead_letter",
          ].map((status) => ({
            id: randomUUID(),
            sessionId: legacyTaskId,
            status,
            shouldRetire: ["queued", "running", "failed"].includes(status),
          })),
          ...[taskId, sharedTaskId, null].flatMap((sessionId) =>
            ["queued", "failed", "succeeded"].map((status) => ({
              id: randomUUID(),
              sessionId,
              status,
              shouldRetire: false,
            })),
          ),
        ];
        for (const job of jobs)
          await sql.execute(
            "insert into public.background_jobs(id,instance_id,project_id,canvas_id,session_id,queue_name,job_type,status,payload,result) values($1,:instance,$2,$3,$4,'image_generation_jobs','image_generation',$5,$6::jsonb,$7::jsonb)",
            [
              job.id,
              projectId,
              canvas.id,
              job.sessionId,
              job.status,
              JSON.stringify({ originRunId: "old-run", audit: true }),
              job.status === "succeeded"
                ? JSON.stringify({ url: "asset:preserved", realResult: true })
                : null,
            ],
          );
        const canvasBefore = await sql.queryOne(
          "select c.* from public.canvases c join public.projects p on p.id=c.project_id where p.instance_id=:instance and c.id=$1",
          [canvas.id],
        );
        const repoRoot = fileURLToPath(
          new URL("../../../../../", import.meta.url),
        );
        // 只验证退役迁移本身：目录里此后并入的并行域迁移不属于本测试范围。
        const files = loadMigrationSet({
          bootstrapDir: join(repoRoot, "supabase/bootstrap"),
          migrationsDir: join(repoRoot, "supabase/migrations"),
        }).filter((file) => file.version <= "20261015091000");
        const queryable = {
          async query<T = Record<string, unknown>>(
            text: string,
            values?: unknown[],
          ) {
            const result = await client.query(text, values);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
        };
        expect((await applyMigrations(queryable, files)).applied).toEqual([
          "20261015091000",
        ]);
        expect((await applyMigrations(queryable, files)).applied).toEqual([]);
        for (const job of jobs) {
          const row = await sql.queryOne(
            "select status,error_code,canceled_at,result,payload from public.background_jobs where instance_id=:instance and id=$1",
            [job.id],
          );
          expect(row).toMatchObject({
            status: job.shouldRetire ? "canceled" : job.status,
            error_code: job.shouldRetire ? "design_session_retired" : null,
            payload: { originRunId: "old-run", audit: true },
          });
          if (job.shouldRetire) expect(row?.canceled_at).not.toBeNull();
          if (job.status === "succeeded")
            expect(row?.result).toEqual({
              url: "asset:preserved",
              realResult: true,
            });
        }
        expect(
          await sql.queryOne(
            "select execution_state,scope_generation,branch_generation,active_run_id,runtime_owner_id from public.design_task_executions where instance_id=:instance and task_id=$1",
            [legacyTaskId],
          ),
        ).toMatchObject({
          execution_state: "failed",
          scope_generation: "2",
          branch_generation: "2",
          active_run_id: null,
          runtime_owner_id: null,
        });
        expect(
          await sql.queryOne(
            "select status,request,fingerprint from public.design_task_inputs where instance_id=:instance and task_id=$1",
            [legacyTaskId],
          ),
        ).toMatchObject({
          status: "canceled",
          request: null,
          fingerprint: "audit-fingerprint",
        });
        expect(
          await sql.queryOne(
            "select state from public.design_task_goals where instance_id=:instance and task_id=$1",
            [legacyTaskId],
          ),
        ).toMatchObject({
          state: {
            status: "paused",
            revision: 4,
            claimedRunId: null,
            evaluation: null,
            objective: "保留审计目标",
          },
        });
        expect(
          await sql.queryOne(
            "select status,consumed_at from public.task_works where instance_id=:instance and id=$1",
            [workId],
          ),
        ).toMatchObject({
          status: "interrupted",
          consumed_at: expect.any(String),
        });
        expect(
          await createTaskWorkStore(db.persistence).find(
            db.instanceId,
            legacyTaskId,
            workId,
          ),
        ).toMatchObject({
          ownerKind: "design",
          status: "interrupted",
          consumed: true,
        });
        expect(
          await sql.queryOne(
            "select task_kind,design_task_id from public.execution_task_owners where instance_id=:instance and task_id=$1",
            [legacyTaskId],
          ),
        ).toEqual({ task_kind: "design", design_task_id: legacyTaskId });
        expect(
          await sql.queryOne(
            "select c.* from public.canvases c join public.projects p on p.id=c.project_id where p.instance_id=:instance and c.id=$1",
            [canvas.id],
          ),
        ).toEqual(canvasBefore);
      } finally {
        await client.end();
        await db.close();
      }
    });
  },
);
