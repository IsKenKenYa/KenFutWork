import type { PermissionTier } from "@loomic/shared";
import { permissionTierSchema } from "@loomic/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 全局权限档位持久化（app_config 单行表，DEC-4）。
 * 实例级配置，无租户维度：直接走 persistence 根客户端（不涉 `:workspace` 谓词）。
 */

export interface PermissionTierStore {
  /** 读回持久化档位；未设置返回 null（服务端回落 default）。 */
  load(): Promise<PermissionTier | null>;
  /** 写穿档位（单行 upsert，幂等）。 */
  save(tier: PermissionTier): Promise<void>;
}

export function createPermissionTierStore(
  persistence: PersistenceService,
): PermissionTierStore {
  return {
    async load() {
      const row = await persistence.queryOne<{ permission_tier: unknown }>(
        "select permission_tier from public.app_config where id = 1",
      );
      if (!row) return null;
      const parsed = permissionTierSchema.safeParse(row.permission_tier);
      return parsed.success ? parsed.data : null;
    },

    async save(tier) {
      await persistence.execute(
        `insert into public.app_config (id, permission_tier)
         values (1, $1)
         on conflict (id) do update
           set permission_tier = excluded.permission_tier,
               updated_at = now()`,
        [tier],
      );
    },
  };
}
