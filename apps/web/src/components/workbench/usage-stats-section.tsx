"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";
import { formatDuration } from "@/lib/usage-format";

// ── R4-2 使用统计（用户侧，设置「数据与统计 → 使用统计」） ──
// 数据来自 /api/usage/stats?days=7|30（usage_records 按 UTC 日聚合）。
// 图表全部手绘 SVG（无图表库依赖）：热力图 + 按模型趋势线 + 用量环图。

interface UsageStats {
  rangeDays: number;
  totals: { tokens: number; inputTokens: number; outputTokens: number };
  peakDayTokens: number;
  currentStreakDays: number;
  longestStreakDays: number;
  /** 单条对话首尾消息的最大跨度（秒）；服务端口径见 usage 仓储的 longestSessionSeconds。 */
  longestSessionSeconds: number;
  daily: Array<{ date: string; tokens: number }>;
  /** 近一年逐日序列（热力图用，固定 365 天）；老服务端可能没有这个字段。 */
  heatmap?: Array<{ date: string; tokens: number }>;
  byModel: Array<{ provider: string; model: string; tokens: number }>;
}

/** 热力图每列的 7 个格子：补位格（没有日期）没有业务键，用固定星期键标记位置 */
const WEEKDAY_CELL_KEYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

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

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** 口径说明（挂在 title 上）：数字含义有歧义时，别让用户自己猜。 */
  hint?: string;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}

/**
 * 热力图：**整年**网格（参考图口径——格子要铺满，不是一小块）。
 *
 * 排布同 GitHub：列 = 周（最多 53 列）、行 = 周一..周日；顶部给月份标签。
 * 数据是近 365 天（缺数据补 0），窗口固定不随范围切换——它是「一年活动全貌」。
 */
function Heatmap({
  heatmap = [],
}: {
  /** 老服务端不带这个字段 → 默认空数组（图区显示空网格），不炸。 */
  heatmap?: UsageStats["heatmap"];
}) {
  const weeks = useMemo(() => {
    if (heatmap.length === 0)
      return [] as Array<Array<{ date: string; tokens: number } | null>>;
    // 首列对齐到周一：把第一周之前的日子补成空格子
    const first = new Date(`${heatmap[0]?.date}T00:00:00Z`);
    const lead = (first.getUTCDay() + 6) % 7;
    const cells: Array<{ date: string; tokens: number } | null> = [
      ...Array.from({ length: lead }, () => null),
      ...heatmap,
    ];
    const columns: Array<Array<{ date: string; tokens: number } | null>> = [];
    for (let i = 0; i < cells.length; i += 7) {
      columns.push(cells.slice(i, i + 7));
    }
    return columns;
  }, [heatmap]);

  const peak = Math.max(1, ...heatmap.map((d) => d.tokens));
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

  // 每月第一次出现的位置打标签（参考图：10月 11月 … 9月）
  const monthLabels = useMemo(() => {
    const labels: Array<{ index: number; label: string }> = [];
    let lastMonth = "";
    weeks.forEach((week, index) => {
      const day = week.find((cell) => cell !== null);
      if (!day) return;
      const month = day.date.slice(5, 7);
      if (month !== lastMonth) {
        labels.push({ index, label: `${Number(month)}月` });
        lastMonth = month;
      }
    });
    return labels;
  }, [weeks]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-max">
        <div className="mb-1 flex gap-[3px] pl-[14px] text-[10px] text-muted-foreground">
          {monthLabels.map((item) => (
            <span
              key={`${item.index}-${item.label}`}
              className="w-[13px] shrink-0"
              style={{ marginLeft: item.index === 0 ? 0 : undefined }}
              data-week={item.index}
            >
              {item.label}
            </span>
          ))}
        </div>
        <div className="flex gap-[3px]">
          <div className="mr-1 flex flex-col justify-between py-[1px] text-[10px] text-muted-foreground">
            <span>一</span>
            <span>四</span>
            <span>日</span>
          </div>
          {weeks.map((week, weekIndex) => (
            <div
              key={week[0]?.date ?? `lead-${weekIndex}`}
              className="flex flex-col gap-[3px]"
            >
              {WEEKDAY_CELL_KEYS.map((dayKey, dayIndex) => {
                const cell = week[dayIndex] ?? null;
                if (!cell) {
                  return <div key={dayKey} className="h-[13px] w-[13px]" />;
                }
                return (
                  <div
                    key={cell.date}
                    title={`${cell.date} · ${formatTokens(cell.tokens)} tokens`}
                    className={`h-[13px] w-[13px] rounded-[3px] ${shades[level(cell.tokens)]}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        近一年每日 token（格子深浅按峰值分档）；数据来自用量记录，只覆盖最近 2
        万条。
      </p>
    </div>
  );
}

/**
 * 每日趋势：平滑折线（参考图口径：曲线要顺，不要一段段尖折角）。
 *
 * 用**单调三次插值**（Fritsch–Carlson）：普通 Catmull-Rom 会在峰值处过冲，
 * 把「一天暴涨」画成负数或虚高的尖角；单调插值保证曲线不过冲出数据范围。
 */
function TrendChart({ daily }: { daily: UsageStats["daily"] }) {
  const width = 560;
  const height = 160;
  const padding = { left: 8, right: 8, top: 8, bottom: 16 };
  const peak = Math.max(1, ...daily.map((d) => d.tokens));
  const pointAt = (index: number, tokens: number) => ({
    x:
      padding.left +
      (index * (width - padding.left - padding.right)) /
        Math.max(1, daily.length - 1),
    y:
      height -
      padding.bottom -
      (tokens / peak) * (height - padding.top - padding.bottom),
  });
  const points = daily.map((day, index) => pointAt(index, day.tokens));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="每日 Token 趋势"
    >
      <path
        d={monotonePath(points)}
        fill="none"
        stroke="currentColor"
        className="text-foreground/70"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {points.map((point, index) => (
        <circle
          key={daily[index]?.date ?? index}
          cx={point.x}
          cy={point.y}
          r="2"
        >
          <title>{`${shortDate(daily[index]?.date ?? "")} · ${formatTokens(daily[index]?.tokens ?? 0)}`}</title>
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
  );
}

/**
 * 单调三次插值的 SVG 路径（Fritsch–Carlson 限幅）。
 *
 * 输入按 x 升序、等距与否都行。切线先按相邻斜率取平均，再按「不过冲」条件限幅，
 * 最后把每段写成三次贝塞尔 —— 曲线不会在峰值附近甩出去。
 *
 * 下标一律走 `at()`：noUncheckedIndexedAccess 下它带 undefined；循环边界已保证 `?? 0`
 * 的兜底分支不可达，只是给类型收窄用。
 */
export function monotonePath(points: Array<{ x: number; y: number }>): string {
  const first = points.at(0);
  if (!first) return "";
  if (points.length === 1) return `M ${first.x} ${first.y}`;

  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const start = points.at(i);
    const end = points.at(i + 1);
    if (!start || !end) continue;
    const deltaX = end.x - start.x;
    dx.push(deltaX);
    slope.push((end.y - start.y) / (deltaX || 1));
  }

  const tangent: number[] = new Array(n).fill(0);
  tangent[0] = slope.at(0) ?? 0;
  tangent[n - 1] = slope.at(n - 2) ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const previous = slope.at(i - 1) ?? 0;
    const next = slope.at(i) ?? 0;
    tangent[i] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  // 限幅：保证每段的切线不把曲线拉过相邻数据点（否则峰值处会过冲）
  for (let i = 0; i < n - 1; i += 1) {
    const s = slope.at(i) ?? 0;
    if (s === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = (tangent.at(i) ?? 0) / s;
    const b = (tangent.at(i + 1) ?? 0) / s;
    const magnitude = Math.hypot(a, b);
    if (magnitude > 3) {
      const scale = 3 / magnitude;
      tangent[i] = scale * a * s;
      tangent[i + 1] = scale * b * s;
    }
  }

  let path = `M ${first.x} ${first.y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const start = points.at(i);
    const end = points.at(i + 1);
    if (!start || !end) continue;
    const third = (dx.at(i) ?? 0) / 3;
    const c1x = start.x + third;
    const c1y = start.y + (tangent.at(i) ?? 0) * third;
    const c2x = end.x - third;
    const c2y = end.y - (tangent.at(i + 1) ?? 0) * third;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
  }
  return path;
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
      <h3 className="text-sm font-medium">使用统计</h3>

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
            {/* 口径挂在 title 上：这是「单条对话首尾消息的跨度」，不是「agent 跑了多久」 */}
            <SummaryCard
              label="最长聊天时长"
              value={formatDuration(stats.longestSessionSeconds)}
              hint="单条对话从第一条消息到最后一条消息的跨度"
            />
          </div>

          <section>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              Token 活动
            </h4>
            <Heatmap heatmap={stats.heatmap ?? []} />
          </section>

          <section>
            {/* 范围切换跟着折线图走（用户口径：7 天/30 天的切换在折线图显示就行） */}
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">
                每日 Token 趋势
              </h4>
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
