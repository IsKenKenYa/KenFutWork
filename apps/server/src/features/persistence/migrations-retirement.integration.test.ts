import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import {
  applyMigrations,
  checksumSql,
  loadMigrationSet,
  type MigrationFile,
} from "./migrations.js";

it.skipIf(process.env.KENFUTWORK_DESKTOP_PG_IT !== "1")(
  "真实旧库并入历史SQL时明确记录取代，不伪造执行、不损失现有数据且拒绝漂移",
  async () => {
    const database = await createTaskWorkDatabase();
    const client = new Client({ connectionString: database.connectionString });
    await client.connect();
    const file = (version: string, sql: string): MigrationFile => ({
      version,
      name: "retirement_test",
      sql,
      checksum: checksumSql(sql),
      path: "test-only.sql",
    });
    const initial = file(
      "20990101000001",
      "create table public.retired_settings (value text)",
    );
    const cleanup = file(
      "20990101000003",
      "drop table public.retired_settings; create table public.current_settings(value text); insert into public.current_settings values ('保留已有配置')",
    );
    const incoming = {
      ...file(
        "20990101000002",
        "alter table public.retired_settings add column extra text",
      ),
      retirement: {
        byVersion: cleanup.version,
        absentRelation: "public.retired_settings",
        presentRelation: "public.current_settings",
      },
    };
    const baseline = loadMigrationSet({
      bootstrapDir: join(process.cwd(), "../../supabase/bootstrap"),
      migrationsDir: join(process.cwd(), "../../supabase/migrations"),
    });
    const db = {
      async query<T>(sql: string, values?: unknown[]) {
        const result = await client.query(sql, values);
        return { rowCount: result.rowCount, rows: result.rows as T[] };
      },
    };
    try {
      await applyMigrations(db, [...baseline, initial, cleanup]);
      const files = [...baseline, initial, incoming, cleanup];
      expect(await applyMigrations(db, files)).toEqual({
        applied: [],
        superseded: [incoming.version],
      });
      const ledger = await client.query(
        "select applied_at,superseded_by,execution_ms from public.schema_migrations where version=$1",
        [incoming.version],
      );
      expect(ledger.rows).toEqual([
        {
          applied_at: null,
          superseded_by: cleanup.version,
          execution_ms: null,
        },
      ]);
      expect(
        (await client.query("select * from public.current_settings")).rows,
      ).toEqual([{ value: "保留已有配置" }]);
      expect(await applyMigrations(db, files)).toEqual({
        applied: [],
        superseded: [],
      });
      await expect(
        applyMigrations(
          db,
          files.map((entry) =>
            entry.version === incoming.version
              ? {
                  ...entry,
                  retirement: {
                    ...incoming.retirement,
                    byVersion: initial.version,
                  },
                }
              : entry,
          ),
        ),
      ).rejects.toThrow(/退役账本/);
      await expect(
        applyMigrations(
          db,
          files.map((entry) =>
            entry.version === incoming.version
              ? { ...entry, checksum: checksumSql("changed") }
              : entry,
          ),
        ),
      ).rejects.toThrow(/校验和/);
      expect(
        (await client.query("select * from public.current_settings")).rows,
      ).toEqual([{ value: "保留已有配置" }]);
    } finally {
      await client.end();
      await database.close();
    }
  },
);
