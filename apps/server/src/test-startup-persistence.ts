import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PersistenceService,
  SqlClient,
  SqlRow,
} from "./features/persistence/types.js";

/** 装配测试只替换SQL驱动，保留真实实例与凭据服务；意外业务写入立即失败。 */
export function createStartupPersistenceFixture(): PersistenceService & {
  dataDir: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "kfw-startup-"));
  const instanceId = randomUUID();
  let lastDataDir: string | null = null;
  let desktop: SqlRow | undefined;
  let tokenHash: unknown;
  const unsupported = (operation: string): never => {
    throw new Error(`路由装配夹具未提供数据库操作：${operation}`);
  };
  const sql: SqlClient = {
    async query<T extends SqlRow>(statement: string): Promise<T[]> {
      if (
        /^select\b/i.test(statement.trim()) &&
        /\bfrom public\.(code_ui_sessions|mcp_servers|provider_instances)\b/i.test(
          statement,
        )
      )
        return [];
      return unsupported(statement);
    },
    async queryOne<T extends SqlRow>(
      statement: string,
      params: readonly unknown[] = [],
    ): Promise<T | null> {
      let row: SqlRow | null;
      if (/insert into public\.local_instances/i.test(statement))
        row = { id: instanceId };
      else if (
        /select last_data_dir from public\.local_instances/i.test(statement)
      )
        row = { last_data_dir: lastDataDir };
      else if (/insert into public\.local_access_clients/i.test(statement)) {
        tokenHash = params[3];
        desktop = {
          id: params[0],
          instance_id: params[1],
          kind: "desktop",
          label: params[2],
          created_at: params[4],
          expires_at: null,
          revoked_at: null,
        };
        row = desktop;
      } else if (/from public\.local_access_clients/i.test(statement)) {
        row =
          params[0] === instanceId && params[1] === tokenHash
            ? (desktop ?? null)
            : null;
      } else if (
        /^select\b/i.test(statement.trim()) &&
        /\bfrom public\.(app_config|instance_settings|provider_registry_revisions)\b/i.test(
          statement,
        )
      )
        row = null;
      else return unsupported(statement);
      // SQL驱动的泛型行边界；具体结果由上述精确语句白名单决定。
      return row as T | null;
    },
    async execute(statement, params = []) {
      if (
        /update public\.local_instances set last_data_dir/i.test(statement) &&
        params[0] === instanceId
      ) {
        lastDataDir = String(params[1]);
        return 1;
      }
      return unsupported(statement);
    },
  };
  const persistence: PersistenceService & { dataDir: string } = {
    ...sql,
    dataDir,
    forInstance(id) {
      if (id !== instanceId) return unsupported(`forInstance(${id})`);
      return { ...sql, instanceId: id };
    },
    transaction: async (fn) =>
      fn({ ...sql, forInstance: (id) => persistence.forInstance(id) }),
    acquireSessionLock: async () => unsupported("acquireSessionLock"),
    ping: async () => {},
    close: async () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return persistence;
}
