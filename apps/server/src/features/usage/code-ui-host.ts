import type { AppUsageHeatmapCell, AppUsageSnapshot } from "@zcode/shared";
import { appUsageSnapshotSchema } from "@zcode/shared";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { UsageRepository } from "./repository.js";

const DAY_MS = 86_400_000;
const RANGE_DAYS = { "7d": 7, "30d": 30 } as const;

/**
 * code-ui「使用统计」面板的数据宿主：`usage_records` 的**真实聚合**。
 *
 * 不造数据的口径（快照 schema 的每个字段都有落点）：
 * - 有真数据的：token 三项、会话数（distinct run，单独计数不跨组相加）、逐日/逐模型
 *   分布、活跃天数、连续活跃、峰值日、最爱模型、最长会话时长（复用 chat 侧口径）；
 * - usage_records 不记录的维度**如实为零/空**：reasoning 与缓存 token、工具调用
 *   （`tools: []`、`toolCallCount: 0`）、TTFT 与轮均时长（schema 允许 null）；
 * - `turnCount`/`totalTurns` 用**模型调用次数**近似——表里没有「轮」的独立记录，
 *   调用次数是同表可查的真实活跃量（热力图 tooltip 的计数语义由此而来）。
 */
export function createCodeUiUsageHost(deps: {
  localInstance: LocalInstanceService;
  repository: Pick<
    UsageRepository,
    "appUsageDaily" | "appUsageRunCount" | "longestSessionSeconds"
  >;
}): Record<string, CodeUiHostRpcHandler> {
  return {
    "usage-stats.getAppUsageSnapshot": {
      async call(
        actor: LocalActor,
        args: unknown[],
      ): Promise<AppUsageSnapshot> {
        const owner = await deps.localInstance.resolve(actor);
        const input = (args[0] ?? {}) as {
          range?: unknown;
          timeZone?: unknown;
        };
        const range =
          input.range === "7d" || input.range === "30d" || input.range === "all"
            ? input.range
            : null;
        if (!range) {
          throw new CodeUiHostRpcError(
            "usage_range_invalid",
            "用量范围只支持 7d / 30d / all。",
            400,
          );
        }
        const timeZone =
          typeof input.timeZone === "string" && input.timeZone.length > 0
            ? input.timeZone
            : "UTC";
        const since =
          range === "all"
            ? null
            : new Date(Date.now() - RANGE_DAYS[range] * DAY_MS);
        const daily = await deps.repository.appUsageDaily(
          owner.instanceId,
          since,
        );
        const totalSessions = await deps.repository.appUsageRunCount(
          owner.instanceId,
          since,
        );

        // —— 按天折叠（一天的多个模型合成一格）——
        const byDay = new Map<
          string,
          { tokens: number; calls: number; byModel: Map<string, number> }
        >();
        for (const row of daily) {
          const bucket = byDay.get(row.day) ?? {
            tokens: 0,
            calls: 0,
            byModel: new Map<string, number>(),
          };
          const tokens = row.inputTokens + row.outputTokens;
          bucket.tokens += tokens;
          bucket.calls += row.calls;
          bucket.byModel.set(
            row.model,
            (bucket.byModel.get(row.model) ?? 0) + tokens,
          );
          byDay.set(row.day, bucket);
        }
        const totalTokens = [...byDay.values()].reduce(
          (s, d) => s + d.tokens,
          0,
        );
        const inputTokens = daily.reduce((s, r) => s + r.inputTokens, 0);
        const outputTokens = daily.reduce((s, r) => s + r.outputTokens, 0);
        const totalCalls = daily.reduce((s, r) => s + r.calls, 0);

        // —— 活跃天数与连续性（UTC 天序列差分）——
        const activeDays = [...byDay.keys()].sort();
        let currentStreakDays = 0;
        let longestStreakDays = 0;
        {
          let prev: number | null = null;
          let run = 0;
          for (const day of activeDays) {
            const idx = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
            run = prev !== null && idx === prev + 1 ? run + 1 : 1;
            longestStreakDays = Math.max(longestStreakDays, run);
            prev = idx;
          }
          if (prev !== null) {
            const today = Math.floor(Date.now() / DAY_MS);
            currentStreakDays = prev === today || prev === today - 1 ? run : 0;
          }
        }

        // —— 峰值日与逐模型汇总 ——
        const peakDayTokens = [...byDay.values()].reduce(
          (m, d) => Math.max(m, d.tokens),
          0,
        );
        const modelTotals = new Map<
          string,
          { tokens: number; input: number; output: number; calls: number }
        >();
        for (const row of daily) {
          const agg = modelTotals.get(row.model) ?? {
            tokens: 0,
            input: 0,
            output: 0,
            calls: 0,
          };
          agg.tokens += row.inputTokens + row.outputTokens;
          agg.input += row.inputTokens;
          agg.output += row.outputTokens;
          agg.calls += row.calls;
          modelTotals.set(row.model, agg);
        }
        const favorite = [...modelTotals.entries()].sort(
          (a, b) => b[1].tokens - a[1].tokens,
        )[0];

        // —— 热力图：首日按周内位置补 null 对齐自然周（周日起），空白天补 0 格；
        //     展示端（UsageHeatmap.buildDisplayHeatmapWeeks）自会补齐 52 周展示格 ——
        const weeks: AppUsageSnapshot["heatmap"]["weeks"] = [];
        let weekDays: Array<AppUsageHeatmapCell | null> = [];
        if (activeDays.length > 0) {
          const firstIdx = Math.floor(
            Date.parse(`${activeDays[0]}T00:00:00Z`) / DAY_MS,
          );
          for (let i = 0; i < new Date(firstIdx * DAY_MS).getUTCDay(); i += 1) {
            weekDays.push(null);
          }
        }
        let prevIdx: number | null = null;
        const emptyCell = (idx: number): AppUsageHeatmapCell => ({
          date: new Date(idx * DAY_MS).toISOString().slice(0, 10),
          level: 0,
          totalTokens: 0,
          turnCount: 0,
          toolCallCount: 0,
        });
        for (const day of activeDays) {
          const idx = Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
          if (prevIdx !== null) {
            for (let gap = prevIdx + 1; gap < idx; gap += 1) {
              weekDays.push(emptyCell(gap));
            }
          }
          const tokens = byDay.get(day)?.tokens ?? 0;
          weekDays.push({
            date: day,
            level: (tokens <= 0 || peakDayTokens <= 0
              ? 0
              : Math.min(
                  4,
                  Math.max(1, Math.ceil((tokens / peakDayTokens) * 4)),
                )) as AppUsageHeatmapCell["level"],
            totalTokens: tokens,
            turnCount: byDay.get(day)?.calls ?? 0,
            toolCallCount: 0,
          });
          prevIdx = idx;
          while (weekDays.length >= 7) {
            weeks.push({ weekIndex: weeks.length, days: weekDays.slice(0, 7) });
            weekDays = weekDays.slice(7);
          }
        }
        if (weekDays.length > 0) {
          weeks.push({ weekIndex: weeks.length, days: weekDays });
        }

        const longestSessionMs =
          (await deps.repository.longestSessionSeconds(owner.instanceId)) *
          1000;

        return appUsageSnapshotSchema.parse({
          range,
          generatedAt: Date.now(),
          timeZone,
          source: "agent-db",
          summary: {
            totalTokens,
            inputTokens,
            outputTokens,
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cacheHitRate: 0,
            totalSessions,
            totalTurns: totalCalls,
            toolCallCount: 0,
            toolErrorRate: 0,
            modelErrorRate: 0,
            avgTimeToFirstTokenMs: null,
            avgTurnDurationMs: null,
            activeDays: activeDays.length,
            currentStreakDays,
            longestStreakDays,
            longestSessionMs,
            peakDayTokens,
            favoriteModel: favorite
              ? {
                  modelId: favorite[0],
                  totalTokens: favorite[1].tokens,
                  share: totalTokens > 0 ? favorite[1].tokens / totalTokens : 0,
                }
              : null,
          },
          heatmap: {
            startDate: activeDays[0] ?? null,
            endDate: activeDays[activeDays.length - 1] ?? null,
            maxTokens: peakDayTokens,
            weeks,
          },
          dailyModelUsage: activeDays.map((day) => ({
            date: day,
            models: [...(byDay.get(day)?.byModel ?? new Map())].map(
              ([modelId, tokens]) => ({ modelId, totalTokens: tokens }),
            ),
          })),
          models: [...modelTotals.entries()].map(([modelId, agg]) => ({
            modelId,
            totalTokens: agg.tokens,
            inputTokens: agg.input,
            outputTokens: agg.output,
            requestCount: agg.calls,
            share: totalTokens > 0 ? agg.tokens / totalTokens : 0,
          })),
          tools: [],
        });
      },
    },
  };
}
