import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrationSet,
} from "../persistence/migrations.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createContextInspectionService } from "./service.js";

it.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "升级已有请求表时保留旧编号和正文，不补造尝试关联",
  async () => {
    const database = await createTaskWorkDatabase({
      stopAtMigration: "20261115140209",
    });
    const client = new Client({ connectionString: database.connectionString });
    try {
      await client.connect();
      const taskId = database.context.scope.taskId;
      const id = randomUUID();
      const input =
        '{"messages":[[{"type":"human","data":{"content":"升级前请求"}}]],"tools":null,"model":"legacy"}';
      await client.query(
        `insert into public.context_model_requests
          (id,instance_id,task_id,run_id,started_at,input_text,input_fingerprint,input_characters,message_count)
          values ($1,$2,$3,$4,now(),$5,'old-fingerprint',$6,1)`,
        [id, database.instanceId, taskId, randomUUID(), input, input.length],
      );
      const files = loadMigrationSet({
        bootstrapDir: fileURLToPath(
          new URL("../../../../../supabase/bootstrap", import.meta.url),
        ),
        migrationsDir: fileURLToPath(
          new URL("../../../../../supabase/migrations", import.meta.url),
        ),
      });
      const db = {
        async query<T = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) {
          const result = await client.query(sql, params);
          return { rowCount: result.rowCount, rows: result.rows as T[] };
        },
      };
      expect((await applyMigrations(db, files)).applied).toEqual([
        "20261115194156",
      ]);
      expect((await applyMigrations(db, files)).applied).toEqual([]);
      const service = createContextInspectionService({
        persistence: database.persistence,
        localInstance: database.localInstance,
        readPageCharacters: async () => 128,
      });
      const { requests } = await service.list(database.actor, { taskId });
      expect(requests.map((request) => request.id)).toEqual([id]);
      expect(requests[0]).not.toHaveProperty("attempt");
      expect(
        await service.read(database.actor, {
          taskId,
          requestId: id,
          part: "input",
        }),
      ).toMatchObject({ text: input, nextOffset: null });
      await expect(
        client.query(
          "update public.context_model_requests set attempt_number=1 where id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.end();
      await database.close();
    }
  },
);
