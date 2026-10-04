import type { PersistenceService } from "./features/persistence/types.js";

/** 路由装配夹具的空数据库：保留真实启动恢复，意外 SQL 或写入立即失败。 */
export function createStartupPersistenceFixture(): PersistenceService {
  const unsupported = (operation: string): never => {
    throw new Error(`路由装配夹具未提供数据库操作：${operation}`);
  };
  return {
    async query(sql) {
      if (
        /^select\b/i.test(sql.trim()) &&
        /\bfrom public\.(code_ui_sessions|mcp_servers)\b/i.test(sql)
      )
        return [];
      return unsupported(sql);
    },
    async queryOne(sql) {
      if (
        /^select\b/i.test(sql.trim()) &&
        /\bfrom public\.app_config\b/i.test(sql)
      )
        return null;
      return unsupported(sql);
    },
    execute: async (sql) => unsupported(sql),
    forUser: (userId) => unsupported(`forUser(${userId})`),
    forWorkspace: (workspaceId) => unsupported(`forWorkspace(${workspaceId})`),
    transaction: async () => unsupported("transaction"),
    acquireSessionLock: async () => unsupported("acquireSessionLock"),
    ping: async () => {},
    close: async () => {},
  };
}
