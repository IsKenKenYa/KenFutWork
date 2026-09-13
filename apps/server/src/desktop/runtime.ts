import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import type { ServerEnv } from "../config/env.js";
import {
  applyMigrations,
  loadMigrationSet,
} from "../features/persistence/migrations.js";
import { resolveDesktopDataDir, resolveDesktopPaths } from "./paths.js";
import { ensurePgmqAvailable, resolvePgmqShimDir } from "./pgmq-shim.js";
import { resolvePgBinDir, startEmbeddedPostgres } from "./postgres.js";

/**
 * 桌面运行时的准备（FORM-2）：在 buildApp 之前把「本机开箱即用」需要的一切就位。
 *
 * 顺序（任一步失败即 fail loud 并回收已启动的资源，不留半启动态）：
 *   1. 解析数据目录、迁移目录、pg 二进制与 shim 目录（全部可用 env 覆盖，便于测试/自托管）；
 *   2. 拉起内嵌 Postgres（首启动 initdb）+ 装 pgmq 兼容 shim；
 *   3. 跑同源迁移（桌面首启动即建全 schema，与开发栈同一批 SQL）；
 *   4. 合并桌面默认：连本机集群、blob 落数据目录、队列进程内。
 *
 * `shutdown` 停库（幂等）；调用方负责在退出路径调用它。
 */

export type DesktopRuntime = {
  env: ServerEnv;
  shutdown(): Promise<void>;
};

/** 是否桌面形态：内嵌数据库或免登录认证任一开启即算。 */
export function isDesktopRuntime(env: ServerEnv): boolean {
  return Boolean(env.embeddedPostgres) || env.authDriver === "local-trust";
}

/** 迁移集目录：`LOOMIC_MIGRATIONS_ROOT` → `<exeDir>/supabase` → `<repoRoot>/supabase`。 */
export function resolveMigrationRoots(input: {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  exeDir?: string;
  repoRoot?: string;
}): { bootstrapDir: string; migrationsDir: string } | undefined {
  const candidates = [
    input.env.LOOMIC_MIGRATIONS_ROOT?.trim(),
    join(input.exeDir ?? process.cwd(), "supabase"),
    join(input.repoRoot ?? process.cwd(), "supabase"),
  ].filter((root): root is string => Boolean(root));

  const root = candidates.find(
    (candidate) =>
      input.exists(join(candidate, "migrations")) &&
      input.exists(join(candidate, "bootstrap")),
  );

  return root
    ? {
        bootstrapDir: join(root, "bootstrap"),
        migrationsDir: join(root, "migrations"),
      }
    : undefined;
}

export async function prepareDesktopRuntime(options: {
  env: ServerEnv;
  /** 打包态传 exe 所在目录；开发态默认 cwd。 */
  exeDir?: string;
  /** 开发态仓库根（定位 supabase/ 与 docker/pg-dev-shim）。 */
  repoRoot?: string;
  onLog?: (message: string) => void;
  /** 覆盖环境探测（测试用）。 */
  processEnv?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}): Promise<DesktopRuntime> {
  const log = options.onLog ?? ((message: string) => console.log(message));
  const exeDir = options.exeDir ?? process.cwd();
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = options.env;

  if (!env.embeddedPostgres) {
    // 非内嵌形态（开发连外部库 / 自托管）：本函数不接管任何生命周期
    return { env, shutdown: async () => {} };
  }

  const { existsSync } = await import("node:fs");
  const exists = options.exists ?? existsSync;
  const processEnv = options.processEnv ?? process.env;

  const dataDir =
    env.desktopDataDir ?? resolveDesktopDataDir({ env: processEnv });
  const paths = resolveDesktopPaths(dataDir);
  await mkdir(paths.dataDir, { recursive: true });

  const binDir = env.pgBinDir ?? resolvePgBinDir({ env: processEnv, exeDir });
  const postgres = await startEmbeddedPostgres({
    binDir,
    dataDir: paths.pgDataDir,
    logFile: paths.pgLogFile,
    onLog: log,
    passwordFile: paths.pgPasswordFile,
    ...(env.embeddedPostgresPort ? { port: env.embeddedPostgresPort } : {}),
  });

  const shutdown = async () => {
    await postgres.stop();
  };

  try {
    const shimDir = resolvePgmqShimDir({ env: processEnv, exeDir, repoRoot });
    const migrationRoots = resolveMigrationRoots({
      env: processEnv,
      exists,
      exeDir,
      repoRoot,
    });
    if (!migrationRoots) {
      throw new Error(
        `未找到迁移目录（应含 migrations/ 与 bootstrap/）：试过 ${join(exeDir, "supabase")} 与 ${join(repoRoot, "supabase")}；可用 LOOMIC_MIGRATIONS_ROOT 指定。`,
      );
    }

    const pool = new Pool({ connectionString: postgres.connectionString });
    try {
      await ensurePgmqAvailable(pool, { binDir, shimDir, onLog: log });
      const migrationSet = loadMigrationSet(migrationRoots);
      const { applied } = await applyMigrations(
        toQueryable(pool),
        migrationSet,
        {
          onApplied: (file) => log(`已执行迁移 ${file.version}_${file.name}`),
        },
      );
      log(
        applied.length > 0
          ? `迁移完成：本次执行 ${applied.length} 条（共 ${migrationSet.length} 条）`
          : `迁移无需执行（${migrationSet.length} 条均已落地）`,
      );
    } finally {
      await pool.end();
    }
  } catch (error) {
    await shutdown();
    throw error;
  }

  return {
    env: {
      ...env,
      // 显式配置优先：桌面下若用户自己配了库/队列/blob，尊重之
      blobDir: env.blobDir ?? paths.blobDir,
      databaseUrl: env.databaseUrl ?? postgres.connectionString,
      queueDriver: env.queueDriver ?? "in-process",
    },
    shutdown,
  };
}

function toQueryable(pool: Pool) {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => {
      const result = await pool.query(text, values);
      return { rowCount: result.rowCount, rows: result.rows as T[] };
    },
  };
}
