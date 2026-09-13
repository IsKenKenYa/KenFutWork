import type { PersistenceService } from "../persistence/types.js";

/**
 * settings 聚合的数据访问（`workspace_settings`）。
 * 表以 `workspace_id` 为主键，故 upsert 天然是「一工作区一行」。
 */
export interface SettingsRepository {
  /** 读默认模型；无行返回 null（由服务落回退默认值）。 */
  findDefaultModel(workspaceId: string): Promise<string | null>;
  /** 一工作区一行，冲突即更新。 */
  upsertDefaultModel(workspaceId: string, defaultModel: string): Promise<void>;
}

type DefaultModelRow = { default_model: string };

export function createSettingsRepository(
  persistence: PersistenceService,
): SettingsRepository {
  return {
    async findDefaultModel(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<DefaultModelRow>(
          `select default_model
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.default_model ?? null;
    },

    async upsertDefaultModel(workspaceId, defaultModel) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, default_model)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set default_model = excluded.default_model`,
        [defaultModel],
      );
    },
  };
}
