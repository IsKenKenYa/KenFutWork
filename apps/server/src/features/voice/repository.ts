import type { PersistenceService } from "../persistence/types.js";

/**
 * 语音设置的数据访问（`instance_settings.voice`，JSON 列）。
 *
 * 边界说明：语音设置住在 settings 聚合的同一张表上，但**只碰自己这一列**
 * （`voice`），与 settings feature 的逐列 upsert 口径一致——同表不同列各自写各的，
 * 两个设置同时保存不会互相盖掉（该口径见 settings/repository.ts 的注释）。
 * 之所以不让 settings-service 代理：语音设置是语音插件的自持状态，消费方也只有
 * `/api/voice/*`，走 settings 聚合会把语音的形状泄漏进通用设置契约。
 */
export interface VoiceRepository {
  /** 读取原始 jsonb；无行返回 null（由服务落缺省）。 */
  findVoice(instanceId: string): Promise<unknown>;
  /** 整列覆盖（语音设置是「一次编辑、整体保存」的形态）。 */
  upsertVoice(instanceId: string, voice: unknown): Promise<void>;
}

type VoiceRow = { voice: unknown };

export function createVoiceRepository(
  persistence: PersistenceService,
): VoiceRepository {
  return {
    async findVoice(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<VoiceRow>(
          `select voice
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.voice ?? null;
    },

    async upsertVoice(instanceId, voice) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, voice)
         values (:instance, $1::jsonb)
         on conflict (instance_id)
         do update set voice = excluded.voice`,
        [JSON.stringify(voice)],
      );
    },
  };
}

/**
 * 检测报告的持久化（`app_config` 单行表，实例级）。
 *
 * 读回策略与权限档位那次一致：**启动期读回 + PUT 先写库再改内存**
 * （`features/permissions/tier-store.ts` 是同一形状的先例），
 * 差别是这里坏值一律当「没测过」（回 null），不猜半个报告。
 */
export interface VoiceDiagnoseStore {
  /** 读回上次报告；无行/坏值返回 null。 */
  load(): Promise<unknown>;
  /** 覆盖写入（单行 upsert，幂等）。 */
  save(report: unknown): Promise<void>;
}

type DiagnoseRow = { voice_diagnose: unknown };

export function createVoiceDiagnoseStore(
  persistence: PersistenceService,
): VoiceDiagnoseStore {
  return {
    async load() {
      const row = await persistence.queryOne<DiagnoseRow>(
        `select voice_diagnose
           from public.app_config where id = 1`,
      );
      return row?.voice_diagnose ?? null;
    },

    async save(report) {
      await persistence.execute(
        `insert into public.app_config (id, voice_diagnose)
         values (1, $1::jsonb)
         on conflict (id) do update
           set voice_diagnose = excluded.voice_diagnose,
               updated_at = now()`,
        [report === null ? null : JSON.stringify(report)],
      );
    },
  };
}
