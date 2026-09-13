import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { resolvePgBinDir, startEmbeddedPostgres } from "./postgres.js";

/**
 * 内嵌 Postgres 真实集成测试（桌面供给，FORM-2）。默认 skipped：需要显式开启。
 *
 *   LOOMIC_DESKTOP_PG_IT=1 pnpm --filter @loomic/server exec vitest run desktop-postgres.integration
 *
 * 为什么必须真跑一次：单元测试用假 run，只能证明「参数拼对了」。这里证明的是
 * ① 二进制目录解析在当前平台成立；② 我们直接 spawn 的 initdb/pg_ctl 参数在真实二进制上
 * 可用（`-o "-p N -c listen_addresses=127.0.0.1"` 这种带空格的转发参数最容易翻车）；
 * ③ 真库上跑通完整迁移集（桌面首启动「同源迁移」口径）；④ 二次启动复用同一集群。
 */
const ENABLED = process.env.LOOMIC_DESKTOP_PG_IT === "1";

describe.skipIf(!ENABLED)("内嵌 Postgres 真实启动（桌面供给）", () => {
  it("首启动 initdb → start → 迁移 40+ → stop → 复用集群重启", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { applyMigrations, loadMigrationSet } = await import(
      "../features/persistence/migrations.js"
    );

    const repoRoot = join(process.cwd(), "..", "..");
    const migrationSet = loadMigrationSet({
      bootstrapDir: join(repoRoot, "supabase", "bootstrap"),
      migrationsDir: join(repoRoot, "supabase", "migrations"),
    });
    expect(migrationSet.length).toBeGreaterThanOrEqual(40);

    const root = await mkdtemp(join(tmpdir(), "loomic-desktop-pg-"));
    const dataDir = join(root, "postgres");
    const binDir = resolvePgBinDir({ env: {}, exeDir: join(root, "nope") });
    const logs: string[] = [];

    const toQueryable = (client: Client) => ({
      query: async <T = Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ) => {
        const result = await client.query(text, values);
        return { rowCount: result.rowCount, rows: result.rows as T[] };
      },
    });

    const first = await startEmbeddedPostgres({
      binDir,
      dataDir,
      logFile: join(root, "logs", "postgres.log"),
      onLog: (message) => logs.push(message),
      passwordFile: join(root, "postgres-password"),
    });

    try {
      // 桌面机不该把数据库暴露到回环之外
      expect(new URL(first.connectionString).hostname).toBe("127.0.0.1");
      expect(
        logs.some((line) => line.includes("已初始化内嵌 Postgres 集群")),
      ).toBe(true);

      const client = new Client({ connectionString: first.connectionString });
      await client.connect();
      try {
        const version = await client.query<{ version: string }>(
          "select version()",
        );
        expect(version.rows[0]?.version).toMatch(/PostgreSQL 17/);

        // 干净集群上没有 pgmq 扩展（FORM-2：桌面包不带第三方扩展），
        // 必须先装兼容 shim，否则历史迁移 `CREATE EXTENSION IF NOT EXISTS pgmq` 直接停链
        const { ensurePgmqAvailable, resolvePgmqShimDir } = await import(
          "./pgmq-shim.js"
        );
        await ensurePgmqAvailable(
          client,
          {
            binDir,
            shimDir: resolvePgmqShimDir({
              env: {},
              exeDir: join(root, "nope"),
              repoRoot,
            }),
            onLog: (message) => logs.push(message),
          },
          {},
        );
        // 不变量：调用后 `CREATE EXTENSION pgmq` 一定可用（首次是 shim 装上去的，
        // 之后读到已装好的文件也会直接通过——shim 装进的是二进制包自己的 share 目录）
        const available = await client.query<{ name: string }>(
          "select name from pg_available_extensions where name = 'pgmq'",
        );
        expect(available.rows).toHaveLength(1);

        const { applied } = await applyMigrations(
          toQueryable(client),
          migrationSet,
        );
        expect(applied).toHaveLength(migrationSet.length);

        // 账本 + 业务表都在（证明迁移真落地，而不是只写了账本）
        const ledger = await client.query<{ count: string }>(
          "select count(*)::text as count from public.schema_migrations",
        );
        expect(Number(ledger.rows[0]?.count)).toBe(migrationSet.length);
        const accounts = await client.query<{ kind: string }>(
          "select relkind::text as kind from pg_class where oid = to_regclass('public.accounts')",
        );
        expect(accounts.rows[0]?.kind).toBe("r");

        // 幂等：二次 apply 无待执行项
        const second = await applyMigrations(toQueryable(client), migrationSet);
        expect(second.applied).toEqual([]);
      } finally {
        await client.end();
      }
    } finally {
      await first.stop();
    }

    // 二次启动：识别为已初始化（不重跑 initdb），数据与口令复用；
    // 端口是每次启动自动挑的空闲端口，故只比对凭据与库名，不比对端口
    const restartedLogs: string[] = [];
    const restarted = await startEmbeddedPostgres({
      binDir,
      dataDir,
      logFile: join(root, "logs", "postgres.log"),
      onLog: (message) => restartedLogs.push(message),
      passwordFile: join(root, "postgres-password"),
    });
    try {
      const before = new URL(first.connectionString);
      const after = new URL(restarted.connectionString);
      expect(after.password).toBe(before.password);
      expect(after.username).toBe(before.username);
      expect(after.pathname).toBe(before.pathname);
      // 复用既有集群：没有再跑 initdb
      expect(
        restartedLogs.some((line) =>
          line.includes("已初始化内嵌 Postgres 集群"),
        ),
      ).toBe(false);

      const client = new Client({
        connectionString: restarted.connectionString,
      });
      await client.connect();
      try {
        const ledger = await client.query<{ count: string }>(
          "select count(*)::text as count from public.schema_migrations",
        );
        expect(Number(ledger.rows[0]?.count)).toBe(migrationSet.length);
      } finally {
        await client.end();
      }
    } finally {
      await restarted.stop();
      await rm(root, { force: true, recursive: true });
    }
  }, 240_000);
});
