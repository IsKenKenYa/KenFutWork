import { type StreamEvent, streamEventSchema } from "@kenfutwork/shared";
import type { PersistenceService } from "../persistence/types.js";
import type {
  RunTimelineEventRow,
  RunTimelineRepository,
  RunTimelineRunRow,
  RunTimelineUsage,
} from "./types.js";

const RUN_STATUSES = [
  "accepted",
  "running",
  "completed",
  "failed",
  "canceled",
] as const;

type RawRunRow = {
  id: string;
  model: string | null;
  status: unknown;
  stop_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
};

type RawEventRow = {
  seq: string | number;
  created_at: string | Date;
  payload: unknown;
};

type RawUsageRow = {
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | number | null;
  calls: string | number | null;
};

/**
 * 时间线聚合的数据访问（只读）。
 * - 运行归属走 `agent_runs → chat_sessions` 的 `instance_id`；
 * - 事件日志按 `event_key` 前缀（`<runId>/<序号>`）取，`code_ui_events`
 *   在删除会话时已经级联删除，不额外做墓碑过滤；
 * - 用量按 `usage_records.run_id` 汇总，成本只在上游声明价格时才有值。
 */
export function createRunTimelineRepository(
  persistence: PersistenceService,
): RunTimelineRepository {
  return {
    async loadRun(instanceId, runId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<RawRunRow>(
          `select r.id, r.model, r.status, r.stop_reason, r.error_code,
                  r.error_message, r.created_at, r.completed_at
             from public.agent_runs r
             join public.chat_sessions s on s.id = r.session_id
            where r.id = $1
              and s.instance_id = :instance`,
          [runId],
        );
      if (!row) return null;
      return {
        runId: row.id,
        model: row.model,
        status: parseStatus(row.status),
        stopReason: row.stop_reason,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        startedAt: toIso(row.created_at),
        completedAt: row.completed_at === null ? null : toIso(row.completed_at),
      } satisfies RunTimelineRunRow;
    },

    async loadEvents(instanceId, runId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<RawEventRow>(
          `select e.seq, e.created_at, e.payload
             from public.code_ui_events e
             join public.code_ui_sessions s on s.id = e.root_session_id
            where e.instance_id = :instance
              and s.instance_id = :instance
              and starts_with(e.event_key, $1 || '/')
            order by e.seq asc`,
          [runId],
        );
      const events: RunTimelineEventRow[] = [];
      for (const row of rows) {
        // 历史版本写过的事件结构可能落后于当前 schema：解析失败的行跳过，
        // 不能让一条旧记录拖垮整轮回看。
        const parsed = streamEventSchema.safeParse(row.payload);
        if (!parsed.success) continue;
        events.push({
          seq: Number(row.seq),
          createdAt: toIso(row.created_at),
          event: parsed.data as StreamEvent,
        });
      }
      return events;
    },

    async loadUsage(instanceId, runId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<RawUsageRow>(
          `select coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  sum(cost_usd) as cost_usd,
                  count(*) as calls
             from public.usage_records
            where instance_id = :instance
              and run_id = $1`,
          [runId],
        );
      if (!row || Number(row.calls ?? 0) === 0) return null;
      return {
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
      } satisfies RunTimelineUsage;
    },
  };
}

function parseStatus(value: unknown): RunTimelineRunRow["status"] {
  const matched = RUN_STATUSES.find((status) => status === value);
  if (!matched) throw new Error(`运行状态未知：${String(value)}`);
  return matched;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
