import { Pool, types } from "pg";

import {
  SqlError,
  UserIsolationError,
  WorkspaceIsolationError,
} from "../errors.js";
import type {
  PersistenceService,
  SqlClient,
  SqlRow,
  SqlTransaction,
  UserSqlClient,
  WorkspaceSqlClient,
} from "../types.js";

/** 工作区谓词占位符：workspace 作用域语句必须显式引用它（`FORM-9`）。 */
export const WORKSPACE_MARKER = ":workspace";

/** 用户谓词占位符：按 `user_id` 定权的表（无 workspace_id）必须显式引用它。 */
export const USER_MARKER = ":user";

const DEFAULT_POOL_MAX = 10;
const PING_SQL = "select 1 as ok";

/** `timestamptz` 的 OID。 */
const OID_TIMESTAMPTZ = 1184;
/** `timestamp`（无时区）的 OID。 */
const OID_TIMESTAMP = 1114;

/**
 * 时间戳归一为 ISO 8601 字符串。
 *
 * 驱动默认把 `timestamp*` 解析成 JS `Date`，而共享契约（`packages/shared`）要求
 * ISO 字符串——原 PostgREST 返回的正是字符串。不归一的话，任何把时间戳回传前端的
 * 接口都会 zod 校验失败（实测 `/api/projects`、`/api/skills` 直接 500）。
 *
 * 放在 Provider 一处解决：17 个聚合的映射层因此不需要各自转换，也不会漏。
 * 无时区的 `timestamp` 按 UTC 解释（本项目所有时间列均以 UTC 写入）。
 */
export function toIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function toIsoTimestampNoZone(value: string): string {
  return new Date(`${value}Z`).toISOString();
}

types.setTypeParser(OID_TIMESTAMPTZ, toIsoTimestamp);
types.setTypeParser(OID_TIMESTAMP, toIsoTimestampNoZone);

export type PostgresResult = { rowCount: number | null; rows: unknown[] };

type QueryFn = (text: string, values: unknown[]) => Promise<PostgresResult>;

/** 独占连接（事务用）：对应池借出的单个物理连接，用完必须 release。 */
export interface PostgresConnection {
  query(text: string, values: unknown[]): Promise<PostgresResult>;
  release(): void;
}

/** 连接池抽象：生产用 pg `Pool`，测试与桌面内嵌实例注入自定义 runner。 */
export interface PostgresQueryRunner {
  query(text: string, values: unknown[]): Promise<PostgresResult>;
  acquire(): Promise<PostgresConnection>;
  end(): Promise<void>;
}

/** 池借出对象与连接对象的共同查询形状（`Pool` 与 `PoolClient` 均满足）。 */
type Queryable = {
  query: (
    text: string,
    values: never[],
  ) => Promise<{
    rowCount: number | null;
    rows: unknown[];
  }>;
};

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

  return createPersistenceFromRunner(createPoolRunner(pool));
}

function createPoolRunner(pool: Pool): PostgresQueryRunner {
  const runOn = (target: Queryable): QueryFn => {
    return async (text, values) => {
      const result = await target.query(text, values as never[]);
      return { rowCount: result.rowCount, rows: result.rows };
    };
  };

  return {
    query: runOn(pool),
    async acquire() {
      const client = await pool.connect();
      return {
        query: runOn(client),
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

/** 由给定 runner 组装服务（测试用假 runner；桌面内嵌 Postgres 复用同一逻辑）。 */
export function createPersistenceFromRunner(
  runner: PostgresQueryRunner,
): PersistenceService {
  const root = createClient(normalizeQuery(runner.query));

  return {
    ...root,
    forUser: (userId) =>
      createUserScopedClient(normalizeQuery(runner.query), userId),
    forWorkspace: (workspaceId) =>
      createWorkspaceClient(normalizeQuery(runner.query), workspaceId),
    transaction: (fn) => runTransaction(runner, fn),
    async ping() {
      await root.query(PING_SQL);
    },
    close: () => runner.end(),
  };
}

/**
 * 单连接事务：回调内语句同事务生效，抛错回滚并原样上抛。
 * 连接在 `finally` 释放——回滚失败也不泄漏连接。
 */
async function runTransaction<T>(
  runner: PostgresQueryRunner,
  fn: (tx: SqlTransaction) => Promise<T>,
): Promise<T> {
  const connection = await runner.acquire();
  const query = normalizeQuery(connection.query);

  try {
    await query("begin", []);
    const result = await fn({
      ...createClient(query),
      forUser: (userId) => createUserScopedClient(query, userId),
      forWorkspace: (workspaceId) => createWorkspaceClient(query, workspaceId),
    });
    await query("commit", []);
    return result;
  } catch (error) {
    try {
      await query("rollback", []);
    } catch {
      // 回滚失败不覆盖原始错误：连接仍被释放，健康度交池判定。
    }
    throw error;
  } finally {
    connection.release();
  }
}

function createClient(query: QueryFn): SqlClient {
  return {
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const result = await query(sql, [...(params ?? [])]);
      return result.rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const result = await query(sql, [...(params ?? [])]);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      const result = await query(sql, [...(params ?? [])]);
      return result.rowCount ?? 0;
    },
  };
}

/** 作用域绑定器：命中标记 → 值追加为末位参数；漏写标记即隔离违约（不下发查询）。 */
type BindFn = (
  sql: string,
  params: readonly unknown[] | undefined,
  operation: string,
) => { text: string; values: unknown[] };

function createBind(
  marker: string,
  value: string,
  makeError: (operation: string) => Error,
): BindFn {
  return (sql, params, operation) => {
    if (!sql.includes(marker)) {
      throw makeError(operation);
    }
    const values = [...(params ?? []), value];
    return { text: sql.split(marker).join(`$${values.length}`), values };
  };
}

/** 作用域客户端的三个查询方法（工作区/用户两种作用域共用，仅绑定器不同）。 */
function createScopedMethods(bind: BindFn, query: QueryFn) {
  return {
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const { text, values } = bind(sql, params, "query");
      const result = await query(text, values);
      return result.rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      const { text, values } = bind(sql, params, "queryOne");
      const result = await query(text, values);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      const { text, values } = bind(sql, params, "execute");
      const result = await query(text, values);
      return result.rowCount ?? 0;
    },
  };
}

function createWorkspaceClient(
  query: QueryFn,
  workspaceId: string,
): WorkspaceSqlClient {
  const bind = createBind(
    WORKSPACE_MARKER,
    workspaceId,
    (operation) => new WorkspaceIsolationError(operation),
  );

  return { workspaceId, ...createScopedMethods(bind, query) };
}

function createUserScopedClient(query: QueryFn, userId: string): UserSqlClient {
  const bind = createBind(
    USER_MARKER,
    userId,
    (operation) => new UserIsolationError(operation),
  );

  return { userId, ...createScopedMethods(bind, query) };
}

/** 把「可能抛驱动错误」的查询函数包成归一错误的 `QueryFn`。 */
function normalizeQuery(raw: QueryFn): QueryFn {
  return async (text, values) => {
    try {
      return await raw(text, values);
    } catch (error) {
      throw toSqlError(error);
    }
  };
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
