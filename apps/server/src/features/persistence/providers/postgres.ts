import { Client, Pool, types } from "pg";

import { InstanceIsolationError, SqlError } from "../errors.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  PersistenceSessionLock,
  SqlClient,
  SqlRow,
  SqlTransaction,
} from "../types.js";

/** 实例谓词占位符：实例作用域语句必须显式引用它（DEC-20）。 */
export const INSTANCE_MARKER = ":instance";

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

export interface PostgresSessionConnection {
  query(text: string, values: unknown[]): Promise<PostgresResult>;
  onLost(listener: (cause: unknown) => void): () => void;
  release(): Promise<void>;
}

/** 连接池抽象：生产用 pg `Pool`，测试与桌面内嵌实例注入自定义 runner。 */
export interface PostgresQueryRunner {
  query(text: string, values: unknown[]): Promise<PostgresResult>;
  acquire(): Promise<PostgresConnection>;
  acquireSession(): Promise<PostgresSessionConnection>;
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
 * 实例隔离在应用层强制。数据库地址来源见 `ServerEnv.databaseUrl`。
 */
export function createPostgresPersistence(options: {
  databaseUrl: string;
  maxConnections?: number;
}): PersistenceService {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? DEFAULT_POOL_MAX,
  });
  // 空闲连接被服务端掐断（PG 重启 / pg_ctl stop -m fast）会以 error 事件抛出；
  // 不接住它就是未捕获异常，会把优雅退出变成崩溃退出。
  pool.on("error", (error) => {
    console.error("[persistence] 连接池空闲连接出错：", error.message);
  });

  return createPersistenceFromRunner(
    createPoolRunner(pool, options.databaseUrl),
  );
}

function createPoolRunner(
  pool: Pool,
  databaseUrl: string,
): PostgresQueryRunner {
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
      // pg-pool借出时移除idle错误监听；查询Promise拒绝之外，断连也会emit error。
      const onConnectionError = (error: Error) => {
        console.error("[persistence] 事务连接出错：", error.message);
      };
      client.on("error", onConnectionError);
      return {
        query: runOn(client),
        release: () => {
          client.release();
          client.off("error", onConnectionError);
        },
      };
    },
    acquireSession: () => createDedicatedSession(databaseUrl, runOn),
    end: () => pool.end(),
  };
}

async function createDedicatedSession(
  databaseUrl: string,
  runOn: (target: Queryable) => QueryFn,
): Promise<PostgresSessionConnection> {
  const client = new Client({ connectionString: databaseUrl });
  const listeners = new Set<(cause: unknown) => void>();
  let lost: unknown;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const publishLoss = (cause: unknown) => {
    if (released || lost !== undefined) return;
    lost = cause;
    for (const listener of listeners) listener(cause);
  };
  client.on("error", publishLoss);
  client.on("end", () => publishLoss(new Error("Postgres 独占会话已断开。")));
  try {
    await client.connect();
  } catch (error) {
    released = true;
    await client.end();
    throw toSqlError(error);
  }
  return {
    query: runOn(client),
    onLost(listener) {
      listeners.add(listener);
      if (lost !== undefined) listener(lost);
      return () => {
        listeners.delete(listener);
      };
    },
    release() {
      releasePromise ??= (async () => {
        released = true;
        await client.end();
      })();
      return releasePromise;
    },
  };
}

async function acquireSessionLock(
  runner: PostgresQueryRunner,
  key: string,
): Promise<PersistenceSessionLock | null> {
  const connection = await runner.acquireSession();
  const query = normalizeQuery(connection.query);
  const controller = new AbortController();
  let physicalLoss = false;
  const removeListener = connection.onLost((cause) => {
    physicalLoss = true;
    controller.abort(toSqlError(cause));
  });
  try {
    // 固定 seed 是 advisory key 的哈希结构常量，不是运行时治理限额。
    const result = await query(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [key],
    );
    controller.signal.throwIfAborted();
    if (!(result.rows[0] as { acquired: boolean } | undefined)?.acquired) {
      removeListener();
      await connection.release();
      return null;
    }
  } catch (error) {
    removeListener();
    await connection.release();
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  return {
    signal: controller.signal,
    release() {
      releasePromise ??= (async () => {
        controller.abort(new Error("Postgres 独占会话已释放。"));
        try {
          if (!physicalLoss)
            await query("select pg_advisory_unlock(hashtextextended($1, 0))", [
              key,
            ]);
        } finally {
          removeListener();
          await connection.release();
        }
      })();
      return releasePromise;
    },
  };
}

/** 由给定 runner 组装服务（测试用假 runner；桌面内嵌 Postgres 复用同一逻辑）。 */
export function createPersistenceFromRunner(
  runner: PostgresQueryRunner,
): PersistenceService {
  const root = createClient(normalizeQuery(runner.query));
  const locks = new Set<PersistenceSessionLock>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  return {
    ...root,
    forInstance: (instanceId) =>
      createInstanceClient(normalizeQuery(runner.query), instanceId),
    transaction: (fn) => runTransaction(runner, fn),
    async acquireSessionLock(key) {
      if (closing) throw new Error("存储服务已关闭，不能认领执行宿主。");
      const lock = await acquireSessionLock(runner, key);
      if (!lock) return null;
      const wrapped: PersistenceSessionLock = {
        signal: lock.signal,
        async release() {
          try {
            await lock.release();
          } finally {
            locks.delete(wrapped);
          }
        },
      };
      if (closing) {
        await wrapped.release();
        throw new Error("存储服务已关闭，不能认领执行宿主。");
      }
      locks.add(wrapped);
      return wrapped;
    },
    async ping() {
      await root.query(PING_SQL);
    },
    close() {
      closing = true;
      closePromise ??= (async () => {
        const outcomes = await Promise.allSettled(
          [...locks].map((lock) => lock.release()),
        );
        await runner.end();
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "部分 Postgres 独占会话未正常释放。",
          );
      })();
      return closePromise;
    },
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
      forInstance: (instanceId) => createInstanceClient(query, instanceId),
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

/** 作用域客户端的三个查询方法（三种方法共享同一实例绑定器）。 */
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

function createInstanceClient(
  query: QueryFn,
  instanceId: string,
): InstanceSqlClient {
  const bind = createBind(
    INSTANCE_MARKER,
    instanceId,
    (operation) => new InstanceIsolationError(operation),
  );

  return { instanceId, ...createScopedMethods(bind, query) };
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
