import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";

import { loadServerEnv } from "./config/env.js";
import {
  adoptLegacyLedger,
  applyMigrations,
  assertNoDrift,
  loadMigrationFiles,
  MigrationError,
  planMigrations,
  readLedgerIfExists,
  type SqlQueryable,
} from "./features/persistence/migrations.js";

/**
 * 迁移执行入口（§4.13 M2.2）。
 *
 *   status  只读：账本 vs 迁移文件的差异（CI/发布前检查用；漂移即退出码 1）
 *   adopt   过渡期一次性：把存量 Supabase 账本导入本执行器账本（不重跑已落地的迁移）
 *   apply   执行待落地迁移（每条一个事务；先做漂移门禁，不通过则一条都不跑）
 *   replay  空库全量重放 + 二次 no-op 自检（在临时库里跑，跑完即删）
 *
 * 用有 DDL 权限的连接执行（运行角色无 DDL），与 API/Worker 的 persistence 口径分开。
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

/** pg 的 `Pool` / `Client` 适配成执行器要的最小结构（多语句 SQL 整段下发）。 */
function toQueryable(target: Pool | Client): SqlQueryable {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => {
      const result = await target.query(text, values);
      return {
        rowCount: result.rowCount,
        rows: result.rows as T[],
      };
    },
  };
}

function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "") || "postgres";
}

async function runStatus(databaseUrl: string): Promise<void> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // 只读：不建账本（校验角色可能没有 DDL 权限），账本缺失即视为 0 条已执行
    const ledger = await readLedgerIfExists(toQueryable(pool));
    const plan = planMigrations(files, ledger);

    console.log(`迁移目录：${MIGRATIONS_DIR}`);
    console.log(`目标库：${describeUrl(databaseUrl)}`);
    console.log(
      `文件 ${files.length} 条 / 已执行 ${ledger.length} 条 / 待执行 ${plan.pending.length} 条`,
    );

    if (plan.checksumDrift.length > 0) {
      console.error("\n[漂移] 已执行的迁移被改动（必须新增前向修复迁移）：");
      for (const { file } of plan.checksumDrift) {
        console.error(`  ${file.version}_${file.name}`);
      }
    }
    if (plan.missingFiles.length > 0) {
      console.error("\n[缺失] 账本有记录但文件已消失（迁移不得删除/重命名）：");
      for (const { recorded } of plan.missingFiles) {
        console.error(`  ${recorded.version}_${recorded.name}`);
      }
    }
    if (plan.pending.length > 0) {
      console.log("\n待执行：");
      for (const file of plan.pending) {
        console.log(`  ${file.version}_${file.name}`);
      }
    }
    if (plan.checksumDrift.length > 0 || plan.missingFiles.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

async function runApply(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await applyMigrations(toQueryable(pool), MIGRATIONS_DIR, {
      onApplied: (file) => console.log(`  已执行 ${file.version}_${file.name}`),
    });
    console.log(
      result.applied.length === 0
        ? "没有待执行的迁移（账本与文件一致）。"
        : `完成：本次执行 ${result.applied.length} 条迁移。`,
    );
  } finally {
    await pool.end();
  }
}

/** 过渡期一次性：把存量 Supabase 账本导入本执行器账本，避免把已落地的迁移当 pending 重跑。 */
async function runAdopt(databaseUrl: string): Promise<void> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { adopted, unknown } = await adoptLegacyLedger(
      toQueryable(pool),
      files,
    );
    console.log(
      `已导入 ${adopted.length} 条执行记录到 public.schema_migrations。`,
    );
    if (unknown.length > 0) {
      console.warn(
        `存量账本里有 ${unknown.length} 个版本在迁移目录中找不到文件（未导入）：\n  ${unknown.join("\n  ")}`,
      );
    }
    const rest = await runStatusAfterAdopt(databaseUrl);
    console.log(
      rest === 0
        ? "账本与迁移文件一致，无待执行项。"
        : `仍有 ${rest} 条待执行迁移，请运行 apply。`,
    );
  } finally {
    await pool.end();
  }
}

/** adopt 后回报待执行条数（复用只读口径，不重复建表）。 */
async function runStatusAfterAdopt(databaseUrl: string): Promise<number> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const plan = planMigrations(
      loadMigrationFiles(MIGRATIONS_DIR),
      await readLedgerIfExists(toQueryable(pool)),
    );
    return plan.pending.length;
  } finally {
    await pool.end();
  }
}

/**
 * 空库全量重放 + 二次 no-op 自检（《AGENTS.md》要求的迁移门禁）。
 * 在临时库里执行，无论成败最后都删库，不污染目标库。
 *
 * 目标态（M1.5「纯 PG 容器」后）这里必须**全绿**：空库能从零建出全部 schema，
 * 说明迁移不依赖 Supabase 供给的 `auth`/`storage` 对象。中性化完成前它会失败，
 * 失败信息即 M2.1 的工作清单。
 */
async function runReplay(databaseUrl: string): Promise<void> {
  const scratch = `loomic_replay_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: databaseUrl });
  const scratchUrl = withDatabase(databaseUrl, scratch);
  // 临时库自己的连接全部显式关闭后再 drop，避免 drop 被占用 / 连接被强杀时炸进程
  const pools: Pool[] = [];

  const scratchPool = () => {
    const pool = new Pool({
      connectionString: scratchUrl,
      // 空库重放可能中途失败，池内错误自行兜住，由执行器抛出可读错误
      max: 1,
    });
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
  };

  await admin.connect();
  await admin.query(`create database ${scratch}`);
  console.log(`已建临时库 ${scratch}（源库 ${describeUrl(databaseUrl)}）`);

  try {
    const total = loadMigrationFiles(MIGRATIONS_DIR).length;

    const first = await applyMigrations(
      toQueryable(scratchPool()),
      MIGRATIONS_DIR,
    );
    console.log(`首轮执行 ${first.applied.length} / ${total} 条`);
    if (first.applied.length !== total) {
      throw new MigrationError(
        `空库重放不完整：应执行 ${total} 条，实际 ${first.applied.length} 条`,
      );
    }

    await assertNoDrift(toQueryable(scratchPool()), MIGRATIONS_DIR);

    const second = await applyMigrations(
      toQueryable(scratchPool()),
      MIGRATIONS_DIR,
    );
    console.log(`二轮执行 ${second.applied.length} 条（应为 0）`);
    if (second.applied.length !== 0) {
      throw new MigrationError(
        `二次 no-op 检查失败：第二轮仍执行了 ${second.applied.length} 条`,
      );
    }

    console.log("空库全量重放 + 二次 no-op 检查通过。");
  } finally {
    for (const pool of pools) {
      await pool.end().catch(() => {});
    }
    await admin.query(`drop database if exists ${scratch}`);
    console.log(`已删除临时库 ${scratch}`);
    await admin.end();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const env = loadServerEnv();
  const databaseUrl = env.databaseUrl;

  if (!databaseUrl) {
    console.error(
      "缺少数据库连接串：请设置 LOOMIC_DATABASE_URL 或 SUPABASE_DB_URL（见 .env.example）。",
    );
    process.exit(1);
  }

  switch (command) {
    case "status":
      await runStatus(databaseUrl);
      return;
    case "apply":
      await runApply(databaseUrl);
      return;
    case "adopt":
      await runAdopt(databaseUrl);
      return;
    case "replay":
      await runReplay(databaseUrl);
      return;
    default:
      console.error(
        `未知子命令：${command}（可用：status | adopt | apply | replay）`,
      );
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof MigrationError) {
    console.error(`[迁移失败] ${error.message}`);
  } else {
    console.error("[迁移失败]", error);
  }
  process.exit(1);
});
