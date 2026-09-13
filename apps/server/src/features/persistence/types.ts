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
 * 工作区隔离客户端（`FORM-9`）：语句必须显式引用 `:workspace` 占位符，
 * 由客户端绑定为当前工作区 id 并追加为末位参数；漏写在执行前抛错——
 * DB 层已无 RLS 兜底，这里把「静默跨工作区读写」变成立即失败。
 */
export interface WorkspaceSqlClient extends SqlClient {
  readonly workspaceId: string;
}

/**
 * persistence 缝的服务定义（三元组 Definition）。
 * Provider：自管 Postgres（`FORM-2` 桌面捆绑实例 / 自托管用户 Postgres）；
 * Consumer：各聚合 repository。
 */
export interface PersistenceService extends SqlClient {
  /** 工作区隔离入口；workspace 归属数据一律经此访问。 */
  forWorkspace(workspaceId: string): WorkspaceSqlClient;
  /** 启动期连通性检查（配置 fail loud）。 */
  ping(): Promise<void>;
  close(): Promise<void>;
}
