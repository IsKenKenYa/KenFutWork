import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { applyMigrations, loadMigrationSet } from "./migrations.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const versions = ["20261024130716", "20261024130940"];

async function expectHistoricalBytes() {
  const files = await run(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "supabase/migrations"],
    { cwd: root },
  );
  for (const path of files.stdout.split("\0").filter(Boolean)) {
    const original = await run("git", ["show", `HEAD:${path}`], {
      cwd: root,
      encoding: "buffer",
    });
    expect(
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
      path,
    ).toBe(createHash("sha256").update(original.stdout).digest("hex"));
  }
  expect(
    (
      await readFile(
        join(
          root,
          "supabase/migrations/20261024130716_code_task_pin_revision.sql",
        ),
      )
    ).byteLength,
  ).toBe(0);
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "置顶前向迁移保持历史字节及原置顶与运行字段，空库全量重放和二次无变化且Schema拒绝越界修订",
  async () => {
    await expectHistoricalBytes();
    const previous = await createTaskWorkDatabase({
      stopAtMigration: "20261024113915",
    });
    const client = new Client({ connectionString: previous.connectionString });
    try {
      await client.connect();
      await client.query(
        "update public.code_ui_sessions set pinned=true where id=$1",
        [previous.context.scope.taskId],
      );
      const before = await client.query(
        "select pinned,revision,updated_at,root_directory from public.code_ui_sessions where id=$1",
        [previous.context.scope.taskId],
      );
      const files = loadMigrationSet({
        bootstrapDir: join(root, "supabase/bootstrap"),
        migrationsDir: join(root, "supabase/migrations"),
      });
      const sql = {
        async query<T>(text: string, values?: unknown[]) {
          const result = await client.query(text, values);
          return { rowCount: result.rowCount, rows: result.rows as T[] };
        },
      };
      expect((await applyMigrations(sql, files)).applied).toEqual(versions);
      expect(await applyMigrations(sql, files)).toEqual({
        applied: [],
        superseded: [],
      });
      const after = await client.query(
        "select pinned,revision,updated_at,root_directory from public.code_ui_sessions where id=$1",
        [previous.context.scope.taskId],
      );
      expect(after.rows).toEqual(before.rows);
      const columns = await client.query(
        "select data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='code_ui_sessions' and column_name='pin_revision'",
      );
      expect(columns.rows).toEqual([
        { data_type: "bigint", is_nullable: "NO", column_default: "0" },
      ]);
      for (const value of [-1, "9007199254740992"])
        await expect(
          client.query(
            "update public.code_ui_sessions set pin_revision=$2 where id=$1",
            [previous.context.scope.taskId, value],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "code_ui_sessions_pin_revision_valid",
        });
      await expectHistoricalBytes();
    } finally {
      await client.end();
      await previous.close();
    }
    const fresh = await createTaskWorkDatabase();
    try {
      expect(fresh.replayed).toEqual(expect.arrayContaining(versions));
      expect(fresh.secondReplay).toEqual([]);
    } finally {
      await fresh.close();
    }
  },
  90_000,
); // 独占临时PostgreSQL的历史升级、空库重放及关闭期限。
