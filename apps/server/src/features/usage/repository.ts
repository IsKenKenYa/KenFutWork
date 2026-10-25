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
  instanceId: string;
  accessClientId?: string | null | undefined;
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
 * usage 聚合的数据访问（`usage_records`，带 `instance_id`）。
 * 写入是遥测追加（原先经服务角色绕过 RLS）；迁移后统一走实例作用域，
 * 追加与读取共用同一隔离口径。
 */
export interface UsageRepository {
  insert(record: NewUsageRecord): Promise<void>;
  /** 最近记录（按发生时间倒序），供汇总聚合。 */
  listRecent(instanceId: string, limit: number): Promise<UsageRecordRow[]>;
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
   * 隔离谓词照 FORM-9 走父链 JOIN（`chat_sessions → canvases → projects.instance_id`），
   * 与 chat 仓储里同一条链一致。
   */
  longestSessionSeconds(instanceId: string): Promise<number>;
  /**
   * 应用用量的逐日×模型聚合（code-ui「使用统计」面板的数据源）。
   *
   * `since = null` 表示全量（range=all）。按 UTC 天聚合——快照 schema 的
   * `timeZone` 只影响展示，热力图消费方按 UTC 日期键对齐。
   */
  appUsageDaily(
    instanceId: string,
    since: Date | null,
  ): Promise<
    Array<{
      day: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      calls: number;
      runs: number;
    }>
  >;
  /** 应用用量涉及的去重会话数（distinct run_id）——不能把逐组 runs 相加（跨天/跨模型会重）。 */
  appUsageRunCount(instanceId: string, since: Date | null): Promise<number>;
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
      await persistence.forInstance(record.instanceId).query(
        `insert into public.usage_records
                (instance_id, access_client_id, provider, model, capability,
                 provider_instance_id, run_id, job_id,
                 input_tokens, output_tokens, total_tokens, cost_usd)
         values (:instance, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (instance_id,job_id) where job_id is not null and capability in ('image','video') do nothing`,
        [
          record.accessClientId ?? null,
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

    async longestSessionSeconds(instanceId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<{ seconds: string | number | null }>(
          `select coalesce(max(span_seconds), 0) as seconds
             from (
               select extract(epoch from (max(m.created_at) - min(m.created_at))) as span_seconds
                 from public.chat_sessions s
                 join public.canvases c on c.id = s.canvas_id
                 join public.projects p on p.id = c.project_id
                 join public.chat_messages m on m.session_id = s.id
                where p.instance_id = :instance
                group by s.id
             ) spans`,
          [],
        );
      const seconds = rows[0]?.seconds ?? 0;
      const parsed = Number(seconds);
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
    },

    async listRecent(instanceId, limit) {
      const rows = await persistence.forInstance(instanceId).query<RawUsageRow>(
        `select provider, model, capability, input_tokens, output_tokens, cost_usd, occurred_at
             from public.usage_records
            where instance_id = :instance
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

    async appUsageDaily(instanceId, since) {
      const rows = await persistence.forInstance(instanceId).query<{
        day: string;
        model: string;
        input_tokens: string | number;
        output_tokens: string | number;
        calls: string | number;
        runs: string | number;
      }>(
        `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day,
                  model,
                  sum(input_tokens) as input_tokens,
                  sum(output_tokens) as output_tokens,
                  count(*) as calls,
                  count(distinct run_id) as runs
             from public.usage_records
            where instance_id = :instance
              and ($1::timestamptz is null or occurred_at >= $1)
            group by 1, 2
            order by 1`,
        [since],
      );

      return rows.map((row) => ({
        day: row.day,
        model: row.model,
        inputTokens: Number(row.input_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        calls: Number(row.calls) || 0,
        runs: Number(row.runs) || 0,
      }));
    },

    async appUsageRunCount(instanceId, since) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<{ runs: string | number }>(
          `select count(distinct run_id) as runs
             from public.usage_records
            where instance_id = :instance
              and run_id is not null
              and ($1::timestamptz is null or occurred_at >= $1)`,
          [since],
        );
      return Number(rows[0]?.runs ?? 0) || 0;
    },
  };
}
