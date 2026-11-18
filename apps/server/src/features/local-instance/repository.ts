import { randomUUID } from "node:crypto";

import type { SqlClient } from "../persistence/types.js";
import type { LocalInstanceRepository } from "./types.js";

/** singleton 唯一约束决定同一本地数据库的稳定身份，不由客户端提供。 */
export function createLocalInstanceRepository(
  database: SqlClient,
): LocalInstanceRepository {
  return {
    async ensure() {
      const row = await database.queryOne<{ id: string }>(
        `insert into public.local_instances (id, singleton)
         values ($1, true)
         on conflict (singleton) do update set singleton = excluded.singleton
         returning id`,
        [randomUUID()],
      );
      if (!row) throw new Error("无法初始化本地实例。");
      return row.id;
    },
  };
}
