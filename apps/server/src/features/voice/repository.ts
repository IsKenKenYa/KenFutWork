import type { PersistenceService } from "../persistence/types.js";

/**
 * 语音设置的数据访问（`workspace_settings.voice`，JSON 列）。
 *
 * 边界说明：语音设置住在 settings 聚合的同一张表上，但**只碰自己这一列**
 * （`voice`），与 settings feature 的逐列 upsert 口径一致——同表不同列各自写各的，
 * 两个设置同时保存不会互相盖掉（该口径见 settings/repository.ts 的注释）。
 * 之所以不让 settings-service 代理：语音设置是语音插件的自持状态，消费方也只有
 * `/api/voice/*`，走 settings 聚合会把语音的形状泄漏进通用设置契约。
 */
export interface VoiceRepository {
  /** 读取原始 jsonb；无行返回 null（由服务落缺省）。 */
  findVoice(workspaceId: string): Promise<unknown>;
  /** 整列覆盖（语音设置是「一次编辑、整体保存」的形态）。 */
  upsertVoice(workspaceId: string, voice: unknown): Promise<void>;
}

type VoiceRow = { voice: unknown };

export function createVoiceRepository(
  persistence: PersistenceService,
): VoiceRepository {
  return {
    async findVoice(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<VoiceRow>(
          `select voice
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.voice ?? null;
    },

    async upsertVoice(workspaceId, voice) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, voice)
         values (:workspace, $1::jsonb)
         on conflict (workspace_id)
         do update set voice = excluded.voice`,
        [JSON.stringify(voice)],
      );
    },
  };
}
