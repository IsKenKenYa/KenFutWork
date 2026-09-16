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
  /**
   * 最长聊天时长（R4-2 剩下的那张卡）：**单会话首尾消息的时间跨度**（秒）。
   *
   * 口径说明（不造数据的底线）：
   * - 取的是 `chat_messages` 里该会话第一条与最后一条 `created_at` 之差，即「这轮对话聊了多久」；
   *   不是「agent 跑了多久」（那要看 `agent_runs` 的 completed-created），也不是「在线时长」。
   * - 逐会话取跨度后再取最大值——不是「所有消息的首尾差」（后者会把跨天的多轮对话算成一条）。
   * - 只有一条消息的会话跨度为 0（真实含义就是「没来回」），照实计入。
   *
   * 为什么这条查询在 usage 域：它属于「使用统计」的口径派生。表在 chat 侧，
   * 隔离谓词照 FORM-9 走父链 JOIN（`chat_sessions → canvases → projects.workspace_id`），
   * 与 chat 仓储里同一条链一致。
   */
  longestSessionSeconds(workspaceId: string): Promise<number>;
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

    async longestSessionSeconds(workspaceId) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<{ seconds: string | number | null }>(
          `select coalesce(max(span_seconds), 0) as seconds
             from (
               select extract(epoch from (max(m.created_at) - min(m.created_at))) as span_seconds
                 from public.chat_sessions s
                 join public.canvases c on c.id = s.canvas_id
                 join public.projects p on p.id = c.project_id
                 join public.chat_messages m on m.session_id = s.id
                where p.workspace_id = :workspace
                group by s.id
             ) spans`,
          [],
        );
      const seconds = rows[0]?.seconds ?? 0;
      const parsed = Number(seconds);
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
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
