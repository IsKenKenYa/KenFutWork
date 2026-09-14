import type { PersistenceService } from "../persistence/types.js";

export type UsageRecordRow = {
  provider: string;
  model: string;
  capability: string;
  /** `bigint` 列：驱动回来是字符串，归一为 number。 */
  input_tokens: number;
  output_tokens: number;
  /** `numeric` 列：驱动回来是字符串，归一为 number。 */
  cost_usd: number | null;
  /** `timestamptz` 列：归一为 ISO 字符串（R4-2 按天聚合用）。 */
  occurred_at: string;
};

export type NewUsageRecord = {
  workspaceId: string;
  userId?: string | undefined;
  provider: string;
  model: string;
  capability: "chat" | "image" | "video";
  providerInstanceId?: string | undefined;
  runId?: string | undefined;
  jobId?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  costUsd?: number | undefined;
};

/**
 * usage 聚合的数据访问（`usage_records`，带 `workspace_id`）。
 * 写入是遥测追加（原先经服务角色绕过 RLS）；迁移后统一走工作区作用域，
 * 追加与读取共用同一隔离口径。
 */
export interface UsageRepository {
  insert(record: NewUsageRecord): Promise<void>;
  /** 最近记录（按发生时间倒序），供汇总聚合。 */
  listRecent(workspaceId: string, limit: number): Promise<UsageRecordRow[]>;
}

type RawUsageRow = {
  provider: string;
  model: string;
  capability: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number | null;
  occurred_at: string | Date;
};

export function createUsageRepository(
  persistence: PersistenceService,
): UsageRepository {
  return {
    async insert(record) {
      await persistence.forWorkspace(record.workspaceId).query(
        `insert into public.usage_records
                (workspace_id, user_id, provider, model, capability,
                 provider_instance_id, run_id, job_id,
                 input_tokens, output_tokens, total_tokens, cost_usd)
         values (:workspace, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.userId ?? null,
          record.provider,
          record.model,
          record.capability,
          record.providerInstanceId ?? null,
          record.runId ?? null,
          record.jobId ?? null,
          record.inputTokens ?? 0,
          record.outputTokens ?? 0,
          record.totalTokens ?? null,
          record.costUsd ?? null,
        ],
      );
    },

    async listRecent(workspaceId, limit) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<RawUsageRow>(
          `select provider, model, capability, input_tokens, output_tokens, cost_usd, occurred_at
             from public.usage_records
            where workspace_id = :workspace
            order by occurred_at desc
            limit $1`,
          [limit],
        );

      return rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        capability: row.capability,
        input_tokens: Number(row.input_tokens) || 0,
        output_tokens: Number(row.output_tokens) || 0,
        cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
        occurred_at:
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : String(row.occurred_at),
      }));
    },
  };
}
