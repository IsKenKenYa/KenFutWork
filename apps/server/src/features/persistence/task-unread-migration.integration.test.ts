import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const version = "20261024113915";

async function expectHistoricalMigrationBytes() {
  const files = await run(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "supabase/migrations"],
    { cwd: root },
  );
  const paths = files.stdout.split("\0").filter(Boolean);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
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
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "未读前向迁移保持历史SHA，空库重放后第二次无变化且实际Schema拒绝越界标记",
  async () => {
    await expectHistoricalMigrationBytes();
    const database = await createTaskWorkDatabase();
    const client = new Client({ connectionString: database.connectionString });
    try {
      expect(database.replayed).toContain(version);
      expect(database.secondReplay).toEqual([]);
      await client.connect();
      const columns = await client.query(
        `select column_name,data_type,is_nullable,column_default
          from information_schema.columns where table_schema='public'
          and table_name='code_ui_sessions' and column_name in ('unread_at','last_unread_at')
          order by column_name`,
      );
      expect(columns.rows).toEqual([
        {
          column_name: "last_unread_at",
          data_type: "bigint",
          is_nullable: "NO",
          column_default: "0",
        },
        {
          column_name: "unread_at",
          data_type: "bigint",
          is_nullable: "YES",
          column_default: null,
        },
      ]);
      for (const [unread, watermark] of [
        [null, -1],
        [1, 0],
        [null, "9007199254740992"],
        [0, 1],
      ])
        await expect(
          client.query(
            "update public.code_ui_sessions set unread_at=$2,last_unread_at=$3 where id=$1",
            [database.context.scope.taskId, unread, watermark],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "code_ui_sessions_unread_marker_valid",
        });
      const initial = await client.query(
        "select unread_at,last_unread_at from public.code_ui_sessions where id=$1",
        [database.context.scope.taskId],
      );
      expect(initial.rows).toEqual([{ unread_at: null, last_unread_at: "0" }]);
      await expectHistoricalMigrationBytes();
    } finally {
      await client.end();
      await database.close();
    }
  },
  90_000,
); // 独占临时PostgreSQL的全量重放、Schema检查及关闭期限。
