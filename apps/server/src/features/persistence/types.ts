/** 参数化 SQL 的行类型（驱动返回的普通对象）。 */
export type SqlRow = Record<string, unknown>;

/**
 * 参数化 SQL 客户端——去 Supabase 后的唯一数据访问入口。
 * 只暴露参数化查询（`$n` 占位符）：业务代码不拼字符串 SQL、不接触驱动类型。
 */
export interface SqlClient {
  query<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
  /** 执行写语句，返回受影响行数。 */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
}

/**
 * 实例隔离客户端（`FORM-9`）：语句必须显式引用 `:instance` 占位符，
 * 由客户端绑定为当前实例 id 并追加为末位参数；漏写在执行前抛错——
 * DB 层已无 RLS 兜底，这里把「静默跨实例读写」变成立即失败。
 */
export interface InstanceSqlClient extends SqlClient {
  readonly instanceId: string;
}

/**
 * 单连接事务句柄：回调内语句同事务提交，抛错整体回滚。
 * 原子写（多表插入与状态更新）必须走事务，禁止用多条独立语句拼「伪事务」。
 */
export interface SqlTransaction extends SqlClient {
  /** 事务内的实例作用域客户端（与根客户端同一隔离规则）。 */
  forInstance(instanceId: string): InstanceSqlClient;
}

/**
 * persistence 缝的服务定义（三元组 Definition）。
 * Provider：自管 Postgres（`FORM-2` 桌面捆绑实例 / 自托管用户 Postgres）；
 * Consumer：各聚合 repository。
 */
/** 同一物理会话持有排他锁；失锁或显式释放时 signal 终止。 */
export interface PersistenceSessionLock {
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

export interface PersistenceService extends SqlClient {
  /** 实例隔离入口；实例归属数据一律经此访问。 */
  forInstance(instanceId: string): InstanceSqlClient;
  /** 原子写入口：回调内全部语句同事务，抛错回滚。 */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  /** 专用长寿命会话，不占普通查询池；未获得排他锁返回 null。 */
  acquireSessionLock(key: string): Promise<PersistenceSessionLock | null>;
  /** 启动期连通性检查（配置 fail loud）。 */
  ping(): Promise<void>;
  close(): Promise<void>;
}
