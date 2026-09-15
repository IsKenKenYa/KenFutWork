"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";

// ── R4-2 使用统计（用户侧，设置「数据与统计 → 使用统计」） ──
// 数据来自 /api/usage/stats?days=7|30（usage_records 按 UTC 日聚合）。
// 图表全部手绘 SVG（无图表库依赖）：热力图 + 按模型趋势线 + 用量环图。

interface UsageStats {
  rangeDays: number;
  totals: { tokens: number; inputTokens: number; outputTokens: number };
  peakDayTokens: number;
  currentStreakDays: number;
  longestStreakDays: number;
  daily: Array<{ date: string; tokens: number }>;
  byModel: Array<{ provider: string; model: string; tokens: number }>;
}

const MODEL_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
];

const compact = new Intl.NumberFormat("zh-CN", { notation: "compact" });

function formatTokens(value: number): string {
  return compact.format(value);
}

function shortDate(date: string): string {
  return date.slice(5).replace("-", "/");
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** 热力图：按周分列（7 行），颜色深浅按当日 token 占峰值的比例分 4 档。 */
function Heatmap({ daily }: { daily: UsageStats["daily"] }) {
  const peak = Math.max(1, ...daily.map((d) => d.tokens));
  const level = (tokens: number) => {
    if (tokens <= 0) return 0;
    const ratio = tokens / peak;
    if (ratio > 0.66) return 4;
    if (ratio > 0.33) return 3;
    if (ratio > 0.05) return 2;
    return 1;
  };
  const shades = [
    "bg-muted",
    "bg-emerald-200/70",
    "bg-emerald-400/70",
    "bg-emerald-500/80",
    "bg-emerald-600",
  ];

  return (
    <div
      className="flex flex-wrap gap-1"
      role="img"
      aria-label="每日 Token 热力图"
    >
      {daily.map((day) => (
        <div
          key={day.date}
          title={`${shortDate(day.date)} · ${formatTokens(day.tokens)} tokens`}
          className={`h-4 w-4 rounded-[3px] ${shades[level(day.tokens)]}`}
        />
      ))}
    </div>
  );
}

/** 每日趋势：每日总 token 的 SVG 折线图。
 *
 * 现有数据粒度是「按天总量 + 按模型总量」（服务端不回按模型逐日序列），
 * 画分模型的多条线会造假数据——所以这里只画总量实线，模型维度交给环图。
 */
function TrendChart({ daily }: { daily: UsageStats["daily"] }) {
  const width = 560;
  const height = 160;
  const padding = { left: 8, right: 8, top: 8, bottom: 16 };
  const peak = Math.max(1, ...daily.map((d) => d.tokens));
  const x = (index: number) =>
    padding.left +
    (index * (width - padding.left - padding.right)) /
      Math.max(1, daily.length - 1);
  const y = (tokens: number) =>
    height -
    padding.bottom -
    (tokens / peak) * (height - padding.top - padding.bottom);

  const linePoints = daily
    .map((day, index) => `${x(index)},${y(day.tokens)}`)
    .join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="每日 Token 趋势"
      >
        <polyline
          points={linePoints}
          fill="none"
          stroke="currentColor"
          className="text-foreground/70"
          strokeWidth="1.5"
        />
        {daily.map((day, index) => (
          <circle key={day.date} cx={x(index)} cy={y(day.tokens)} r="2">
            <title>{`${shortDate(day.date)} · ${formatTokens(day.tokens)}`}</title>
          </circle>
        ))}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth="0.5"
          className="text-muted-foreground/40"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{shortDate(daily[0]?.date ?? "")}</span>
        <span>{shortDate(daily[daily.length - 1]?.date ?? "")}</span>
      </div>
    </div>
  );
}

/** 模型用量环图：环段按份额绘制，右侧图例带 token 数。 */
function UsageDonut({ byModel }: { byModel: UsageStats["byModel"] }) {
  const total = byModel.reduce((sum, model) => sum + model.tokens, 0);
  const segments = useMemo(() => {
    const top = byModel.slice(0, 6);
    const restTokens =
      total - top.reduce((sum, model) => sum + model.tokens, 0);
    const list = top.map((model, index) => ({
      label: model.model,
      tokens: model.tokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length] ?? "#71717a",
    }));
    if (restTokens > 0) {
      list.push({ label: "其他", tokens: restTokens, color: "#71717a" });
    }
    return list;
  }, [byModel, total]);

  if (total <= 0) {
    return <p className="text-xs text-muted-foreground">暂无用量数据。</p>;
  }

  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-5">
      <svg
        viewBox="0 0 140 140"
        className="h-32 w-32"
        role="img"
        aria-label="模型用量占比"
      >
        {segments.map((segment) => {
          const fraction = segment.tokens / total;
          const dash = fraction * circumference;
          const circle = (
            <circle
              key={segment.label}
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth="14"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            >
              <title>{`${segment.label} · ${formatTokens(segment.tokens)}`}</title>
            </circle>
          );
          offset += dash;
          return circle;
        })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-xs">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: segment.color }}
            />
            <span className="min-w-0 flex-1 truncate">{segment.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatTokens(segment.tokens)}（
              {Math.round((segment.tokens / total) * 100)}%）
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UsageStatsSection() {
  const { session } = useAuth();
  const [days, setDays] = useState<7 | 30>(7);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const token = session?.access_token;
    if (!token) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/usage/stats?days=${days}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("统计加载失败。");
      setStats((await response.json()) as UsageStats);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "统计加载失败。");
    } finally {
      setLoading(false);
    }
  }, [session, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">使用统计</h3>
        <div className="flex items-center gap-1 rounded-lg border p-0.5 text-xs">
          {([7, 30] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-active={days === option}
              onClick={() => setDays(option)}
              className="rounded-md px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-muted data-[active=true]:font-medium data-[active=true]:text-foreground"
            >
              近 {option} 日
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {loading && !stats ? (
        <p className="text-xs text-muted-foreground">正在加载…</p>
      ) : null}

      {stats ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <SummaryCard
              label="累计 Token 数"
              value={formatTokens(stats.totals.tokens)}
            />
            <SummaryCard
              label="峰值 Token 数（单日）"
              value={formatTokens(stats.peakDayTokens)}
            />
            <SummaryCard
              label="当前连续天数"
              value={`${stats.currentStreakDays} 天`}
            />
            <SummaryCard
              label="最长连续天数"
              value={`${stats.longestStreakDays} 天`}
            />
          </div>

          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              Token 活动
            </h4>
            <Heatmap daily={stats.daily} />
          </section>

          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              每日 Token 趋势
            </h4>
            <TrendChart daily={stats.daily} />
          </section>

          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              模型用量
            </h4>
            <UsageDonut byModel={stats.byModel} />
          </section>
        </>
      ) : null}
    </div>
  );
}
