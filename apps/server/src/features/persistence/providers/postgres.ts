import { Pool } from "pg";

import { SqlError, WorkspaceIsolationError } from "../errors.js";
import type {
  PersistenceService,
  SqlClient,
  SqlRow,
  WorkspaceSqlClient,
} from "../types.js";

/** 工作区谓词占位符：workspace 作用域语句必须显式引用它（`FORM-9`）。 */
export const WORKSPACE_MARKER = ":workspace";

const DEFAULT_POOL_MAX = 10;
const PING_SQL = "select 1 as ok";

/** 连接池抽象：生产用 pg `Pool`，测试与桌面内嵌实例注入自定义 runner。 */
export interface PostgresQueryRunner {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
  end(): Promise<void>;
}

/**
 * 自管 Postgres Provider（`FORM-2`/`FORM-9`）：单一信任 DB 角色、参数化查询、
 * 工作区隔离在应用层强制。数据库地址来源见 `ServerEnv.databaseUrl`。
 */
export function createPostgresPersistence(options: {
  databaseUrl: string;
  maxConnections?: number;
}): PersistenceService {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? DEFAULT_POOL_MAX,
  });

  return createPersistenceFromRunner({
    query: async (text, values) => {
      const result = await pool.query(text, values as never[]);
      return { rowCount: result.rowCount, rows: result.rows };
    },
    end: () => pool.end(),
  });
}

/** 由给定 runner 组装服务（测试用假 runner；桌面内嵌 Postgres 复用同一逻辑）。 */
export function createPersistenceFromRunner(
  runner: PostgresQueryRunner,
): PersistenceService {
  const root = createClient(runner);

  return {
    ...root,
    forWorkspace: (workspaceId) => createWorkspaceClient(runner, workspaceId),
    async ping() {
      await root.query(PING_SQL);
    },
    close: () => runner.end(),
  };
}

function createClient(runner: PostgresQueryRunner): SqlClient {
  return {
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const result = await runRaw(runner, sql, [...(params ?? [])]);
      return result.rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const result = await runRaw(runner, sql, [...(params ?? [])]);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      const result = await runRaw(runner, sql, [...(params ?? [])]);
      return result.rowCount ?? 0;
    },
  };
}

function createWorkspaceClient(
  runner: PostgresQueryRunner,
  workspaceId: string,
): WorkspaceSqlClient {
  /** 绑定工作区：`:workspace` 命中末位占位符；漏写即隔离违约（不下发查询）。 */
  const bind = (
    sql: string,
    params: readonly unknown[] | undefined,
    operation: string,
  ) => {
    if (!sql.includes(WORKSPACE_MARKER)) {
      throw new WorkspaceIsolationError(operation);
    }
    const values = [...(params ?? []), workspaceId];
    return {
      text: sql.split(WORKSPACE_MARKER).join(`$${values.length}`),
      values,
    };
  };

  return {
    workspaceId,
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const { text, values } = bind(sql, params, "query");
      const result = await runRaw(runner, text, values);
      return result.rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const { text, values } = bind(sql, params, "queryOne");
      const result = await runRaw(runner, text, values);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      const { text, values } = bind(sql, params, "execute");
      const result = await runRaw(runner, text, values);
      return result.rowCount ?? 0;
    },
  };
}

async function runRaw(
  runner: PostgresQueryRunner,
  sql: string,
  values: unknown[],
): Promise<{ rowCount: number | null; rows: unknown[] }> {
  try {
    return await runner.query(sql, values);
  } catch (error) {
    throw toSqlError(error);
  }
}

/** 驱动错误 → `SqlError`：只保留判重需要的字段，业务代码不依赖 pg 错误形状。 */
function toSqlError(error: unknown): SqlError {
  if (error instanceof SqlError) {
    return error;
  }

  if (error instanceof Error) {
    const raw = error as Error & {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
    };
    return new SqlError(error.message, {
      code: typeof raw.code === "string" ? raw.code : undefined,
      constraint:
        typeof raw.constraint === "string" ? raw.constraint : undefined,
      detail: typeof raw.detail === "string" ? raw.detail : undefined,
    });
  }

  return new SqlError(`[persistence] SQL 执行失败：${String(error)}`);
}
