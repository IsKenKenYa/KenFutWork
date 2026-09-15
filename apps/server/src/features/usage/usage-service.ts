import type { UsageStatsResponse, UsageSummaryResponse } from "@loomic/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerRepository } from "../bootstrap/repository.js";
import type { UsageRecordRow, UsageRepository } from "./repository.js";

/**
 * usage 缝（DEC-6）：token/成本计量，按 workspace/provider/model/run 落账。
 * 写入与读取都经 `persistence` 缝的工作区作用域（隔离口径与其它聚合一致）。
 */

const SUMMARY_ROW_LIMIT = 10000;
const STATS_ROW_LIMIT = 20000;

export interface UsageEntry {
  workspaceId: string;
  /** 归属用户：平台池计费与管理后台按用户聚合都需要。 */
  userId?: string;
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
  summarize(user: AuthenticatedUser): Promise<UsageSummaryResponse>;
  /** 用户侧使用统计（R4-2）：按天活动/连续天数/按模型，窗口 rangeDays 天。 */
  stats(
    user: AuthenticatedUser,
    rangeDays: number,
  ): Promise<UsageStatsResponse>;
  /** agent 链路结算：run 只有 userId，落账前解析个人工作区。 */
  resolveWorkspaceIdByUser(userId: string): Promise<string | undefined>;
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
  /** 复用 workspaces 域的数据访问（worker 进程无 auth，故不经 viewer 服务）。 */
  workspaces: ViewerRepository;
  /** 可注入时钟（测试固定「今天」）；缺省真实时间。 */
  now?: () => Date;
}): UsageService {
  const { repository, workspaces } = options;

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
  ): UsageStatsResponse {
    const today = now.toISOString().slice(0, 10);
    const windowStart = addUtcDays(today, -(rangeDays - 1));

    const dailyTotals = new Map<string, number>();
    const modelTotals = new Map<string, { provider: string; tokens: number }>();
    const totals = { tokens: 0, inputTokens: 0, outputTokens: 0 };

    for (const row of rows) {
      const date = utcDateOf(row.occurred_at);
      if (date < windowStart || date > today) continue;
      const tokens = row.input_tokens + row.output_tokens;
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
      daily,
      byModel: [...modelTotals.entries()]
        .map(([model, bucket]) => ({
          provider: bucket.provider,
          model,
          tokens: bucket.tokens,
        }))
        .sort((a, b) => b.tokens - a.tokens),
    };
  }

  async function resolveWorkspaceIdByUser(
    userId: string,
  ): Promise<string | undefined> {
    const workspace = await workspaces
      .findPersonalWorkspace(userId)
      .catch(() => null);
    return workspace?.id;
  }

  return {
    resolveWorkspaceIdByUser,

    async record(entry) {
      try {
        await repository.insert({
          workspaceId: entry.workspaceId,
          ...(entry.userId ? { userId: entry.userId } : {}),
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
      const workspaceId = await resolveWorkspaceIdByUser(user.id);
      if (!workspaceId) {
        throw new Error("[usage] summary query failed: workspace not found");
      }

      const rows = await repository
        .listRecent(workspaceId, SUMMARY_ROW_LIMIT)
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
      const workspaceId = await resolveWorkspaceIdByUser(user.id);
      if (!workspaceId) {
        throw new Error("[usage] stats query failed: workspace not found");
      }
      const rows = await repository
        .listRecent(workspaceId, STATS_ROW_LIMIT)
        .catch((error: unknown) => {
          throw new Error(
            `[usage] stats query failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return buildStats(rows, rangeDays, (options.now ?? (() => new Date()))());
    },
  };
}
