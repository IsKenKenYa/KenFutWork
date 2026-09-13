import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  assertNoDrift,
  checksumSql,
  type LedgerRecord,
  loadMigrationFiles,
  loadMigrationSet,
  MigrationError,
  type MigrationFile,
  parseMigrationFileName,
  planMigrations,
  type SqlQueryable,
} from "./migrations.js";

function migrationFile(
  version: string,
  name: string,
  sql = `select '${version}'`,
): MigrationFile {
  return {
    checksum: checksumSql(sql),
    name,
    path: `/x/${version}_${name}.sql`,
    sql,
    version,
  };
}

function ledgerRecord(file: MigrationFile): LedgerRecord {
  return {
    applied_at: "2026-09-13T00:00:00.000Z",
    checksum: file.checksum,
    name: file.name,
    version: file.version,
  };
}

/** 记录 SQL 的假连接：可注入失败，用于验证「漂移即不执行」与回滚。 */
function createDb(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const db: SqlQueryable = {
    async query<T>(text: string) {
      calls.push(text.replace(/\s+/g, " ").trim());
      if (options.failOn && text.includes(options.failOn)) {
        throw new Error("boom");
      }
      return { rowCount: 0, rows: [] as T[] };
    },
  };
  return { calls, db };
}

/** 账本查询固定返回给定记录，避免假连接解析 select 语句。 */
function dbWithLedger(
  records: readonly LedgerRecord[],
  options: { failOn?: string } = {},
) {
  const inner = createDb(options);
  const db: SqlQueryable = {
    async query<T>(text: string) {
      if (text.includes("from public.schema_migrations")) {
        inner.calls.push("<ledger-select>");
        return { rowCount: records.length, rows: records as T[] };
      }
      return inner.db.query<T>(text);
    },
  };
  return { calls: inner.calls, db };
}

function writeMigrations(files: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "loomic-migrations-"));
  for (const [fileName, sql] of files) {
    writeFileSync(join(dir, fileName), sql, "utf8");
  }
  return dir;
}

describe("迁移文件名解析", () => {
  it("解析 YYYYMMDDHHmmss_描述.sql，描述可含下划线", () => {
    expect(
      parseMigrationFileName(
        "20260323000001_loomic_supabase_foundation_v1.sql",
      ),
    ).toEqual({
      name: "loomic_supabase_foundation_v1",
      version: "20260323000001",
    });
  });

  it("文件名不合法即抛错（不静默跳过）", () => {
    expect(() => parseMigrationFileName("not-a-migration.sql")).toThrow(
      MigrationError,
    );
    expect(() => parseMigrationFileName("20260323_short.sql")).toThrow(
      MigrationError,
    );
  });
});

describe("迁移装载", () => {
  it("按版本升序装载，忽略非 sql 文件", () => {
    const dir = writeMigrations([
      ["20260323000002_b.sql", "select 2"],
      ["20260323000001_a.sql", "select 1"],
      ["README.md", "not sql"],
    ]);

    const files = loadMigrationFiles(dir);

    expect(files.map((f) => f.version)).toEqual([
      "20260323000001",
      "20260323000002",
    ]);
    expect(files.map((f) => f.name)).toEqual(["a", "b"]);
    expect(files[0]?.checksum).toBe(checksumSql("select 1"));
  });

  it("时间戳重复即抛错（同一版本不能有两条历史）", () => {
    const dir = writeMigrations([
      ["20260323000001_a.sql", "select 1"],
      ["20260323000001_b.sql", "select 2"],
    ]);

    expect(() => loadMigrationFiles(dir)).toThrow(/时间戳重复/);
  });
});

describe("供给前导与历史合成一个迁移集", () => {
  it("前导排在历史之前（保留版本段 000000000000NN 数值上先于时间戳）", () => {
    const bootstrapDir = writeMigrations([
      ["00000000000001_neutral_supply.sql", "select 'bootstrap'"],
    ]);
    const migrationsDir = writeMigrations([
      ["20260323000001_foundation.sql", "select 'history-1'"],
      ["20260323000002_hardening.sql", "select 'history-2'"],
    ]);

    const set = loadMigrationSet({ bootstrapDir, migrationsDir });

    expect(set.map((f) => f.name)).toEqual([
      "neutral_supply",
      "foundation",
      "hardening",
    ]);
  });

  it("不给前导目录时就是纯历史集（自托管/生产迁移路径不变）", () => {
    const migrationsDir = writeMigrations([
      ["20260323000001_foundation.sql", "select 1"],
    ]);

    const set = loadMigrationSet({ migrationsDir });

    expect(set.map((f) => f.version)).toEqual(["20260323000001"]);
  });
});

describe("迁移计划", () => {
  it("区分待执行 / 校验和漂移 / 文件缺失", () => {
    const done = migrationFile("20260323000001", "done");
    const drifted = migrationFile("20260323000002", "drifted");
    const pending = migrationFile("20260323000003", "pending");

    const plan = planMigrations(
      [done, drifted, pending],
      [
        ledgerRecord(done),
        // 账本记录的是旧校验和 → 该迁移被改动过
        { ...ledgerRecord(drifted), checksum: "0".repeat(64) },
        // 账本里有、文件里没有
        {
          applied_at: "2026-09-13T00:00:00.000Z",
          checksum: "1".repeat(64),
          name: "gone",
          version: "20260323000000",
        },
      ],
    );

    expect(plan.pending.map((f) => f.version)).toEqual(["20260323000003"]);
    expect(plan.checksumDrift.map((d) => d.file.version)).toEqual([
      "20260323000002",
    ]);
    expect(plan.missingFiles.map((m) => m.recorded.name)).toEqual(["gone"]);
  });

  it("账本为空时全部待执行", () => {
    const files = [
      migrationFile("20260323000001", "a"),
      migrationFile("20260323000002", "b"),
    ];

    const plan = planMigrations(files, []);

    expect(plan.pending).toHaveLength(2);
    expect(plan.checksumDrift).toHaveLength(0);
    expect(plan.missingFiles).toHaveLength(0);
  });
});

describe("漂移门禁（禁止改已执行的迁移）", () => {
  it("校验和不一致 → 抛错并点名是哪条", async () => {
    const drifted = migrationFile("20260323000002", "drifted");
    const dir = writeMigrations([["20260323000002_drifted.sql", drifted.sql]]);
    const { db } = dbWithLedger([
      { ...ledgerRecord(drifted), checksum: "0".repeat(64) },
    ]);

    await expect(assertNoDrift(db, loadMigrationFiles(dir))).rejects.toThrow(
      /20260323000002_drifted/,
    );
  });

  it("账本有记录但文件消失 → 抛错（迁移不得删除/重命名）", async () => {
    const dir = writeMigrations([["20260323000001_a.sql", "select 1"]]);
    const { db } = dbWithLedger([
      {
        applied_at: "2026-09-13T00:00:00.000Z",
        checksum: "1".repeat(64),
        name: "gone",
        version: "20260323000000",
      },
    ]);

    await expect(assertNoDrift(db, loadMigrationFiles(dir))).rejects.toThrow(
      /20260323000000_gone/,
    );
  });
});

describe("执行迁移", () => {
  it("只跑待执行项、按升序、每条一个事务并写账本", async () => {
    const a = migrationFile("20260323000001", "a", "create table t1 ()");
    const b = migrationFile("20260323000002", "b", "create table t2 ()");
    const dir = writeMigrations([
      ["20260323000001_a.sql", a.sql],
      ["20260323000002_b.sql", b.sql],
    ]);
    const applied: string[] = [];
    let clock = 1000;
    const { calls, db } = dbWithLedger([ledgerRecord(a)]);

    const result = await applyMigrations(db, loadMigrationFiles(dir), {
      now: () => (clock += 5),
      onApplied: (file) => applied.push(file.version),
    });

    expect(result.applied).toEqual(["20260323000002"]);
    expect(applied).toEqual(["20260323000002"]);

    // 建账本 → 查账本 → begin → 迁移体 → 记账本 → commit（a 已执行故不出现）
    const executable = calls.filter((sql) => sql !== "<ledger-select>");
    expect(executable[0]).toContain(
      "create table if not exists public.schema_migrations",
    );
    expect(executable).toContain("create table t2 ()");
    expect(executable).not.toContain("create table t1 ()");
    expect(executable.filter((sql) => sql === "begin")).toHaveLength(1);
    expect(executable.filter((sql) => sql === "commit")).toHaveLength(1);
    expect(
      executable.some((sql) =>
        sql.startsWith("insert into public.schema_migrations"),
      ),
    ).toBe(true);
  });

  it("漂移时一条都不执行（先门禁后动手）", async () => {
    const a = migrationFile("20260323000001", "a");
    const dir = writeMigrations([["20260323000001_a.sql", a.sql]]);
    const { calls, db } = dbWithLedger([
      { ...ledgerRecord(a), checksum: "0".repeat(64) },
    ]);

    await expect(applyMigrations(db, loadMigrationFiles(dir))).rejects.toThrow(
      MigrationError,
    );

    const executable = calls.filter((sql) => sql !== "<ledger-select>");
    expect(executable).not.toContain("begin");
    expect(executable.some((sql) => sql.startsWith("insert into"))).toBe(false);
  });

  it("迁移体失败 → 回滚且不写账本", async () => {
    const a = migrationFile("20260323000001", "a", "this is not sql");
    const dir = writeMigrations([["20260323000001_a.sql", a.sql]]);
    const { calls, db } = dbWithLedger([], { failOn: "this is not sql" });

    await expect(applyMigrations(db, loadMigrationFiles(dir))).rejects.toThrow(
      /已回滚/,
    );

    const executable = calls.filter((sql) => sql !== "<ledger-select>");
    expect(executable).toContain("rollback");
    expect(executable).not.toContain("commit");
    expect(executable.some((sql) => sql.startsWith("insert into"))).toBe(false);
  });

  it("账本已齐时二次执行是 no-op", async () => {
    const a = migrationFile("20260323000001", "a");
    const dir = writeMigrations([["20260323000001_a.sql", a.sql]]);
    const { calls, db } = dbWithLedger([ledgerRecord(a)]);

    const result = await applyMigrations(db, loadMigrationFiles(dir));

    expect(result.applied).toEqual([]);
    expect(calls.filter((sql) => sql !== "<ledger-select>")).not.toContain(
      "begin",
    );
  });
});
