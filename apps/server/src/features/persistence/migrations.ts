import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 迁移执行器（§4.13 M2.2；《AGENTS.md》「数据库迁移」硬约束的运行时落实）。
 *
 * 三条不可协商的规则：
 * 1. **前向修复**：已执行的迁移文件不得就地改。执行前逐个比对 SHA-256，账本里记录的
 *    校验和与当前文件不一致（或文件消失）即**拒绝执行并报错**，绝不静默重跑。
 * 2. **账本唯一权威**：`public.schema_migrations` 是执行历史的唯一来源，不覆盖校验和。
 * 3. **每条迁移单独事务**：中途失败不留半个迁移。
 *
 * 与业务数据访问的分工：本模块是 **DDL/迁移**，按《AGENTS.md》由一次性迁移任务用有
 * DDL 权限的角色执行，**不**走 `persistence` 的业务口径（那条路径是运行角色、无 DDL）。
 * 故这里依赖的是「能发多语句 SQL 的连接」这一最小结构，而不是 `SqlClient`——迁移体里
 * 有 `$$ … $$` 块与多语句，必须整段交给驱动，不能用带参数的单语句接口。
 */

/** pg 的 `Pool` / `Client` 在这一子集上与执行器兼容（CLI 里做一层薄适配）。 */
export type SqlQueryable = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
};

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export type MigrationFile = {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export type LedgerRecord = {
  applied_at: string;
  checksum: string;
  name: string;
  version: string;
};

export type MigrationPlan = {
  pending: MigrationFile[];
  /** 账本有记录但校验和变了 → 已执行迁移被改动（前向修复违规）。 */
  checksumDrift: Array<{ file: MigrationFile; recorded: string }>;
  /** 账本有记录但文件没了 → 迁移被删除或重命名（同为违规）。 */
  missingFiles: Array<{ recorded: LedgerRecord }>;
};

/** 迁移文件名形如 `20260323000001_loomic_supabase_foundation_v1.sql`。 */
const FILE_PATTERN = /^(\d{14})_(.+)\.sql$/;

export function parseMigrationFileName(fileName: string): {
  name: string;
  version: string;
} {
  const matched = FILE_PATTERN.exec(fileName);
  if (!matched) {
    throw new MigrationError(
      `迁移文件名不合法：${fileName}（应为 YYYYMMDDHHmmss_描述.sql）`,
    );
  }
  return { name: matched[2] as string, version: matched[1] as string };
}

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function loadMigrationFiles(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".sql"))
    .map((fileName) => {
      const { name, version } = parseMigrationFileName(fileName);
      const path = join(dir, fileName);
      const sql = readFileSync(path, "utf8");
      return { checksum: checksumSql(sql), name, path, sql, version };
    });

  files.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new MigrationError(`迁移时间戳重复：${file.version}`);
    }
    seen.add(file.version);
  }

  return files;
}

const LEDGER_TABLE = "public.schema_migrations";

/** 过渡期存量账本（Supabase CLI 维护）：`adopt` 从这里导入既有执行史。 */
const LEGACY_LEDGER = "supabase_migrations.schema_migrations";

/**
 * 建账本（幂等）。账本自身是执行器唯一的 DDL 例外——没有账本就无法记录任何迁移。
 */
export async function ensureLedger(db: SqlQueryable): Promise<void> {
  await db.query(`create table if not exists ${LEDGER_TABLE} (
    version text primary key,
    name text not null,
    checksum text not null,
    execution_ms integer,
    applied_at timestamptz not null default now()
  )`);
}

/**
 * 只读读取账本；账本不存在时返回空数组而**不建表**。
 * `status` 走这条：CI/发布前的校验角色可能没有 DDL 权限。
 */
export async function readLedgerIfExists(
  db: SqlQueryable,
): Promise<LedgerRecord[]> {
  const { rows } = await db.query<{ present: string | null }>(
    "select to_regclass($1)::text as present",
    [LEDGER_TABLE],
  );
  if (!rows[0]?.present) {
    return [];
  }
  return readLedger(db);
}

export async function readLedger(db: SqlQueryable): Promise<LedgerRecord[]> {
  const { rows } = await db.query<LedgerRecord>(
    `select version, name, checksum, applied_at from ${LEDGER_TABLE} order by version`,
  );
  return rows;
}

/**
 * 把存量账本（Supabase CLI 的 `supabase_migrations.schema_migrations`）导入本执行器账本。
 *
 * 过渡期一次性动作：既有库的 schema 由 Supabase CLI 落地，本执行器此前没有账本；
 * 直接把 33 条当 pending 重跑会撞「表已存在」。导入的是**真实的执行事实**（版本+名称
 * 取自存量账本），校验和只能取当前文件（存量账本只存 statement，不回存文件）——
 * 这是把既有历史登记进来，不是覆盖账本。
 *
 * 只导入**文件与账本都对得上**的版本；仅存在于存量账本的孤儿版本会被列出但不导入。
 */
export async function adoptLegacyLedger(
  db: SqlQueryable,
  files: readonly MigrationFile[],
): Promise<{ adopted: string[]; unknown: string[] }> {
  await ensureLedger(db);

  const legacyExists = await db.query<{ present: string | null }>(
    "select to_regclass($1)::text as present",
    [LEGACY_LEDGER],
  );
  if (!legacyExists.rows[0]?.present) {
    throw new MigrationError(
      `存量账本 ${LEGACY_LEDGER} 不存在——该库不是由 Supabase CLI 供给的？`,
    );
  }

  const { rows: legacyRows } = await db.query<{
    name: string;
    version: string;
  }>(`select version, name from ${LEGACY_LEDGER} order by version`);
  const fileByVersion = new Map(files.map((file) => [file.version, file]));

  const adopted: string[] = [];
  const unknown: string[] = [];

  for (const row of legacyRows) {
    const file = fileByVersion.get(row.version);
    if (!file) {
      unknown.push(row.version);
      continue;
    }
    await db.query(
      `insert into ${LEDGER_TABLE} (version, name, checksum)
       values ($1, $2, $3)
       on conflict (version) do nothing`,
      [file.version, file.name, file.checksum],
    );
    adopted.push(file.version);
  }

  return { adopted, unknown };
}

export function planMigrations(
  files: readonly MigrationFile[],
  ledger: readonly LedgerRecord[],
): MigrationPlan {
  const recordedByVersion = new Map(ledger.map((row) => [row.version, row]));
  const fileVersions = new Set(files.map((file) => file.version));

  const pending: MigrationFile[] = [];
  const checksumDrift: MigrationPlan["checksumDrift"] = [];

  for (const file of files) {
    const recorded = recordedByVersion.get(file.version);
    if (!recorded) {
      pending.push(file);
      continue;
    }
    if (recorded.checksum !== file.checksum) {
      checksumDrift.push({ file, recorded: recorded.checksum });
    }
  }

  const missingFiles = ledger
    .filter((row) => !fileVersions.has(row.version))
    .map((recorded) => ({ recorded }));

  return { checksumDrift, missingFiles, pending };
}

/**
 * 校验账本与文件一致（只读）。漂移即抛错——这是「禁止改已执行迁移」的门禁。
 */
export async function assertNoDrift(
  db: SqlQueryable,
  files: readonly MigrationFile[],
): Promise<MigrationPlan> {
  const plan = planMigrations(files, await readLedger(db));

  if (plan.checksumDrift.length > 0) {
    const detail = plan.checksumDrift
      .map(({ file }) => `${file.version}_${file.name}`)
      .join("\n  ");
    throw new MigrationError(
      `已执行的迁移被改动（校验和不匹配），必须改用新增的前向修复迁移：\n  ${detail}`,
    );
  }

  if (plan.missingFiles.length > 0) {
    const detail = plan.missingFiles
      .map(({ recorded }) => `${recorded.version}_${recorded.name}`)
      .join("\n  ");
    throw new MigrationError(
      `账本里有记录但文件已消失（迁移不得删除或重命名）：\n  ${detail}`,
    );
  }

  return plan;
}

/** 把一条迁移写入账本。 */
async function recordApplied(
  db: SqlQueryable,
  file: MigrationFile,
  executionMs: number,
): Promise<void> {
  await db.query(
    `insert into ${LEDGER_TABLE} (version, name, checksum, execution_ms)
     values ($1, $2, $3, $4)`,
    [file.version, file.name, file.checksum, executionMs],
  );
}

/**
 * 装载完整迁移集：**供给前导**（`supabase/bootstrap/`）在前，历史迁移在后。
 *
 * 前导用保留版本号 `000000000000NN`（14 位、数值上先于一切时间戳），作用是把
 * Supabase 供给的对象（`extensions`/`auth`/`storage`/`pgmq`/角色）**物化**成自管对象，
 * 使历史迁移能在空库上重放（§4.13 M2.1「剔除/物化」）。放在独立目录而非
 * `supabase/migrations/`，是为了不污染 Supabase CLI 的历史与残留统计口径。
 */
export function loadMigrationSet(dirs: {
  bootstrapDir?: string | undefined;
  migrationsDir: string;
}): MigrationFile[] {
  const bootstrap = dirs.bootstrapDir
    ? loadMigrationFiles(dirs.bootstrapDir)
    : [];
  return [...bootstrap, ...loadMigrationFiles(dirs.migrationsDir)];
}

/**
 * 应用所有待执行迁移（按版本升序，每条一个事务）。
 * 先做漂移校验：不通过则**一条都不执行**（宁可不动，也不在不确定的历史上继续）。
 */
export async function applyMigrations(
  db: SqlQueryable,
  files: readonly MigrationFile[],
  options: {
    /** 注入时钟，便于测试；默认 `Date.now`。 */
    now?: () => number;
    onApplied?: (file: MigrationFile) => void;
  } = {},
): Promise<{ applied: string[] }> {
  const now = options.now ?? (() => Date.now());

  await ensureLedger(db);
  const plan = await assertNoDrift(db, files);
  const applied: string[] = [];

  for (const file of plan.pending) {
    const startedAt = now();
    // 一条迁移一个事务：中途失败整条回滚，不留半个迁移
    await db.query("begin");
    try {
      await db.query(file.sql);
      await recordApplied(db, file, now() - startedAt);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw new MigrationError(
        `迁移 ${file.version}_${file.name} 执行失败，已回滚：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    applied.push(file.version);
    options.onApplied?.(file);
  }

  return { applied };
}
