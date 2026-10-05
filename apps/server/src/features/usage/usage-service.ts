import type {
  UsageStatsResponse,
  UsageSummaryResponse,
} from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { UsageRecordRow, UsageRepository } from "./repository.js";

/**
 * usage 缝（DEC-6）：token/成本计量，按 instance/provider/model/run 落账。
 * 写入与读取都经 `persistence` 缝的实例作用域（隔离口径与其它聚合一致）。
 */

const SUMMARY_ROW_LIMIT = 10000;
const STATS_ROW_LIMIT = 20000;
/** 热力图窗口：一整年（参考图铺满 12 个月）。 */
const HEATMAP_DAYS = 365;

export interface UsageEntry {
  instanceId: string;
  /** 发起接入客户端只作为可选遥测，稳定归属始终是实例。 */
  accessClientId?: string | null;
  provider: string;
  model: string;
  capability: "chat" | "image" | "video";
  providerInstanceId?: string;
  runId?: string;
  jobId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface UsageService {
  record(entry: UsageEntry): Promise<void>;
  summarize(user: LocalActor): Promise<UsageSummaryResponse>;
  /** 用户侧使用统计（R4-2）：按天活动/连续天数/按模型，窗口 rangeDays 天。 */
  stats(user: LocalActor, rangeDays: number): Promise<UsageStatsResponse>;
}

type ModelBucket = {
  provider: string;
  model: string;
  capability: "chat" | "image" | "video";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function createUsageService(options: {
  repository: UsageRepository;
  localInstance: LocalInstanceService;
  /** 可注入时钟（测试固定「今天」）；缺省真实时间。 */
  now?: () => Date;
}): UsageService {
  const { repository, localInstance } = options;

  function aggregate(rows: UsageRecordRow[]) {
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const byModel = new Map<string, ModelBucket>();

    for (const row of rows) {
      const costUsd = row.cost_usd ?? 0;
      totals.inputTokens += row.input_tokens;
      totals.outputTokens += row.output_tokens;
      totals.costUsd += costUsd;

      const key = `${row.provider}:${row.model}`;
      const bucket = byModel.get(key) ?? {
        provider: row.provider,
        model: row.model,
        capability: row.capability as "chat" | "image" | "video",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      bucket.inputTokens += row.input_tokens;
      bucket.outputTokens += row.output_tokens;
      bucket.costUsd += costUsd;
      byModel.set(key, bucket);
    }

    return { byModel, totals };
  }

  /** UTC 日期口径（YYYY-MM-DD）；usage 行的 occurred_at 已归一为 ISO 字符串。 */
  function utcDateOf(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
  }

  function addUtcDays(date: string, delta: number): string {
    const ms = Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /**
   * 统计窗口派生（纯函数）：连续序列、峰值、当前/最长连续天数、按模型聚合。
   * 当前连续天数：从今天往回数，今天没活动则从昨天起算（半开口径，不打断昨天刚跑完的用户）。
   */
  function buildStats(
    rows: UsageRecordRow[],
    rangeDays: number,
    now: Date,
    /**
     * 最长聊天时长来自**另一个数据源**（会话/消息表），故由调用方传入而不是在函数里兜默认值：
     * 类型上强制调用方显式提供，避免「忘了查」被静默成 0。
     */
    longestSessionSeconds: number,
  ): UsageStatsResponse {
    const today = now.toISOString().slice(0, 10);
    const windowStart = addUtcDays(today, -(rangeDays - 1));

    const dailyTotals = new Map<string, number>();
    const modelTotals = new Map<string, { provider: string; tokens: number }>();
    const totals = { tokens: 0, inputTokens: 0, outputTokens: 0 };

    // 热力图要铺满一年（参考图是一整年的格子），故另起一个窗口的逐日聚合
    const heatmapStart = addUtcDays(today, -(HEATMAP_DAYS - 1));
    const heatmapTotals = new Map<string, number>();

    for (const row of rows) {
      const date = utcDateOf(row.occurred_at);
      const tokens = row.input_tokens + row.output_tokens;
      if (date >= heatmapStart && date <= today) {
        heatmapTotals.set(date, (heatmapTotals.get(date) ?? 0) + tokens);
      }
      if (date < windowStart || date > today) continue;
      totals.tokens += tokens;
      totals.inputTokens += row.input_tokens;
      totals.outputTokens += row.output_tokens;
      dailyTotals.set(date, (dailyTotals.get(date) ?? 0) + tokens);
      const bucket = modelTotals.get(row.model) ?? {
        provider: row.provider,
        tokens: 0,
      };
      bucket.tokens += tokens;
      modelTotals.set(row.model, bucket);
    }

    const heatmap: UsageStatsResponse["heatmap"] = [];
    for (let i = 0; i < HEATMAP_DAYS; i += 1) {
      const date = addUtcDays(heatmapStart, i);
      heatmap.push({ date, tokens: heatmapTotals.get(date) ?? 0 });
    }

    const daily: UsageStatsResponse["daily"] = [];
    for (let i = 0; i < rangeDays; i += 1) {
      const date = addUtcDays(windowStart, i);
      daily.push({ date, tokens: dailyTotals.get(date) ?? 0 });
    }

    const active = new Set(
      daily.filter((d) => d.tokens > 0).map((d) => d.date),
    );
    let longestStreakDays = 0;
    let runLength = 0;
    for (const day of daily) {
      runLength = active.has(day.date) ? runLength + 1 : 0;
      longestStreakDays = Math.max(longestStreakDays, runLength);
    }
    let currentStreakDays = 0;
    let cursor = active.has(today) ? today : addUtcDays(today, -1);
    while (active.has(cursor)) {
      currentStreakDays += 1;
      cursor = addUtcDays(cursor, -1);
    }

    return {
      rangeDays,
      totals,
      peakDayTokens: daily.reduce((peak, day) => Math.max(peak, day.tokens), 0),
      currentStreakDays,
      longestStreakDays,
      longestSessionSeconds,
      daily,
      heatmap,
      byModel: [...modelTotals.entries()]
        .map(([model, bucket]) => ({
          provider: bucket.provider,
          model,
          tokens: bucket.tokens,
        }))
        .sort((a, b) => b.tokens - a.tokens),
    };
  }

  return {
    async record(entry) {
      try {
        await repository.insert({
          instanceId: entry.instanceId,
          ...(entry.accessClientId
            ? { accessClientId: entry.accessClientId }
            : {}),
          provider: entry.provider,
          model: entry.model,
          capability: entry.capability,
          ...(entry.providerInstanceId
            ? { providerInstanceId: entry.providerInstanceId }
            : {}),
          ...(entry.runId ? { runId: entry.runId } : {}),
          ...(entry.jobId ? { jobId: entry.jobId } : {}),
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          ...(entry.totalTokens != null
            ? { totalTokens: entry.totalTokens }
            : {}),
          ...(entry.costUsd != null ? { costUsd: entry.costUsd } : {}),
        });
      } catch (error) {
        // 计量失败不阻断主链路（「有剑不用」：usage 是旁路观测，不是主链路）
        console.warn(
          "[usage] failed to record usage:",
          error instanceof Error ? error.message : error,
        );
      }
    },

    async summarize(user): Promise<UsageSummaryResponse> {
      const { instanceId } = await localInstance.resolve(user);

      const rows = await repository
        .listRecent(instanceId, SUMMARY_ROW_LIMIT)
        .catch((error: unknown) => {
          throw new Error(
            `[usage] summary query failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

      const { byModel, totals } = aggregate(rows);

      return {
        totals: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
        },
        byModel: [...byModel.values()].map((bucket) => ({
          provider: bucket.provider,
          model: bucket.model,
          capability: bucket.capability,
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          ...(bucket.costUsd > 0 ? { costUsd: bucket.costUsd } : {}),
        })),
      };
    },

    async stats(user, rangeDays): Promise<UsageStatsResponse> {
      const { instanceId } = await localInstance.resolve(user);
      const rows = await repository
        .listRecent(instanceId, STATS_ROW_LIMIT)
        .catch((error: unknown) => {
          throw new Error(
            `[usage] stats query failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      // 最长聊天时长来自会话/消息表（与 usage_records 无关的第二个数据源）：
      // 它失败不该把整页统计打成 500 —— 卡片显示 0 并在日志留痕，其余数字照常给。
      const longestSessionSeconds = await repository
        .longestSessionSeconds(instanceId)
        .catch((error: unknown) => {
          console.error(
            "[usage] longestSessionSeconds query failed:",
            error instanceof Error ? error.message : error,
          );
          return 0;
        });
      return buildStats(
        rows,
        rangeDays,
        (options.now ?? (() => new Date()))(),
        longestSessionSeconds,
      );
    },
  };
}
