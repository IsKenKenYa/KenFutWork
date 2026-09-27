"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";
import {
  SETTINGS_SECTION_GAP,
  SETTINGS_TITLE_TEXT,
} from "@/lib/settings-layout";
import { formatDuration } from "@/lib/usage-format";

// ── 使用统计（用户侧，设置「数据与统计 → 使用统计」） ──
// 布局一比一对照 docs/参考图/设置添加使用统计以及索引相关内容.png：
// 汇总条（单卡分栏）→ Token 活动卡（全年热力图，铺满宽度**不出滚动条**）→
// 时间范围行（近 7 日/近 30 日）→ 每日 Token 趋势图卡（按模型多线 + 图例）→ 模型用量卡（环图）。
// 数据来自 /api/usage/stats?days=7|30；图表全部手绘 SVG（无图表库依赖）。

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
  /** 逐日 × 模型序列（与 daily 按下标对齐）；老服务端可能没有这个字段。 */
  dailyByModel?: Array<{ model: string; tokens: number[] }>;
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

/** 与参考图同序：蓝 绿 紫 红 橙 青（趋势线与环图共用同一份着色）。 */
const MODEL_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#f59e0b",
  "#14b8a6",
];

const compact = new Intl.NumberFormat("zh-CN", { notation: "compact" });

function formatTokens(value: number): string {
  return compact.format(value);
}

function axisDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

/** 卡片容器（参考图：每个区块一张圆角卡，标题在卡内左上）。 */
function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 分段切换（每日/累计、近 7 日/近 30 日共用这一形态）。 */
function SegmentedToggle<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    /* fieldset 而非 div+role="group"：同样的分组语义，但用语义元素（lint/a11y/useSemanticElements） */
    <fieldset
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs"
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          data-active={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-[5px] px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-sm"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * 热力图：**整年**网格，参考图口径——格子要铺满卡片宽度（列数固定、格子随容器伸缩），
 * **不出横向滚动条**（此前固定 13px 格 + overflow-x-auto，实测在弹窗宽度下必出滚动条）。
 *
 * 排布同 GitHub：列 = 周（53 列）、行 = 周一..周日；月份标签在网格**下方**（参考图同款）。
 */
function Heatmap({
  heatmap = [],
  mode,
}: {
  /** 老服务端不带这个字段 → 默认空数组（图区显示空网格），不炸。 */
  heatmap?: UsageStats["heatmap"];
  /** 视图：每日 / 累计（状态在 section，切换钮在卡片标题行）。 */
  mode: "daily" | "cumulative";
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

  /** 「累计」视图：按时间先后做 running sum（同一年窗口，颜色表达累计量）。 */
  const values = useMemo(() => {
    if (mode === "daily") return heatmap;
    let running = 0;
    return heatmap.map((day) => {
      running += day.tokens;
      return { date: day.date, tokens: running };
    });
  }, [heatmap, mode]);

  const peak = Math.max(1, ...values.map((d) => d.tokens));
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

  // 每月第一次出现的位置打标签（参考图：10月 11月 … 9月，排在网格下方）
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

  if (weeks.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无活动数据</p>;
  }

  return (
    <div>
      <div className="flex gap-[3px]">
        <div className="mr-1 flex w-4 shrink-0 flex-col justify-between py-[1px] text-[10px] leading-none text-muted-foreground">
          <span>一</span>
          <span>四</span>
          <span>日</span>
        </div>
        {weeks.map((week, weekIndex) => (
          <div
            key={week[0]?.date ?? `lead-${weekIndex}`}
            className="flex min-w-0 flex-1 flex-col gap-[3px]"
          >
            {WEEKDAY_CELL_KEYS.map((dayKey, dayIndex) => {
              const cell = week[dayIndex] ?? null;
              if (!cell) {
                return <div key={dayKey} className="aspect-square w-full" />;
              }
              return (
                <div
                  key={cell.date}
                  title={`${cell.date} · ${formatTokens(cell.tokens)} tokens`}
                  className={`aspect-square w-full rounded-[2px] ${shades[level(cell.tokens)]}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="relative mt-1 ml-5 h-4">
        {monthLabels.map((item) => (
          <span
            key={`${item.index}-${item.label}`}
            className="absolute text-[10px] leading-4 text-muted-foreground"
            style={{ left: `${(item.index / weeks.length) * 100}%` }}
          >
            {item.label}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        近一年{mode === "daily" ? "每日" : "累计"} token 用量（近 2 万条）
      </p>
    </div>
  );
}

/**
 * 每日趋势：**按模型多条**平滑折线（参考图：图例在上、虚线网格、日期轴在下）。
 *
 * 用**单调三次插值**（Fritsch–Carlson）：普通 Catmull-Rom 会在峰值处过冲，
 * 把「一天暴涨」画成负数或虚高的尖角；单调插值保证曲线不过冲出数据范围。
 */
function TrendChart({
  dates,
  series,
}: {
  dates: string[];
  series: Array<{ label: string; color: string; tokens: number[] }>;
}) {
  const width = 560;
  const height = 200;
  const padding = { left: 8, right: 8, top: 10, bottom: 20 };
  const peak = Math.max(
    1,
    ...series.flatMap((item) => item.tokens.map((tokens) => tokens)),
  );
  const xAt = (index: number) =>
    padding.left +
    (index * (width - padding.left - padding.right)) /
      Math.max(1, dates.length - 1);
  const yAt = (tokens: number) =>
    height -
    padding.bottom -
    (tokens / peak) * (height - padding.top - padding.bottom);
  const paths = series.map((item) => ({
    ...item,
    path: monotonePath(
      item.tokens.map((tokens, index) => ({
        x: xAt(index),
        y: yAt(tokens),
      })),
    ),
  }));
  /** 日期轴刻度：最多 8 个、均匀取样（7 天全标，30 天约 6 个）。 */
  const tickStep = Math.max(1, Math.ceil(dates.length / 8));
  const ticks = dates.filter((_, index) => index % tickStep === 0);

  return (
    <div>
      {series.length > 0 ? (
        <ul
          aria-label="模型图例"
          className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
        >
          {series.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: item.color }}
              />
              <span className="text-muted-foreground">{item.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="每日 Token 趋势"
      >
        {/* 横向虚线网格（参考图：三条淡淡的虚线，不分刻度值） */}
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={padding.left}
            x2={width - padding.right}
            y1={
              padding.top + (height - padding.top - padding.bottom) * fraction
            }
            y2={
              padding.top + (height - padding.top - padding.bottom) * fraction
            }
            stroke="currentColor"
            strokeWidth="0.5"
            strokeDasharray="3 4"
            className="text-muted-foreground/40"
          />
        ))}
        {paths.map((item) => (
          <path
            key={item.label}
            d={item.path}
            fill="none"
            stroke={item.color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ))}
        {/* 日期轴 */}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth="0.5"
          className="text-muted-foreground/40"
        />
        {ticks.map((date) => {
          const index = dates.indexOf(date);
          return (
            <text
              key={date}
              x={xAt(index)}
              y={height - padding.bottom + 14}
              textAnchor={
                index === 0
                  ? "start"
                  : index === dates.length - 1
                    ? "end"
                    : "middle"
              }
              className="fill-current text-[9px] text-muted-foreground"
            >
              {axisDate(date)}
            </text>
          );
        })}
      </svg>
    </div>
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

/** 模型用量环图：环段按份额绘制，右侧图例（模型名 + token 数，百分比靠右）。 */
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
    return <p className="text-xs text-muted-foreground">暂无用量数据</p>;
  }

  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-6">
      <svg
        viewBox="0 0 140 140"
        className="h-32 w-32 shrink-0"
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
      <ul
        aria-label="模型用量图例"
        className="min-w-0 flex-1 space-y-2 text-xs"
      >
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: segment.color }}
            />
            <span className="min-w-0 flex-1 truncate">{segment.label}</span>
            <span className="text-muted-foreground">
              {formatTokens(segment.tokens)}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
              {Math.round((segment.tokens / total) * 100)}%
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
  const [heatMode, setHeatMode] = useState<"daily" | "cumulative">("daily");
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

  /** 趋势图按模型拆线：与 byModel 同序（用量降序），颜色共用一份调色板。 */
  const trendSeries = useMemo(() => {
    if (!stats) return [];
    const dailyByModel = stats.dailyByModel ?? [];
    return dailyByModel.slice(0, MODEL_COLORS.length).map((entry, index) => ({
      label: entry.model,
      color: MODEL_COLORS[index % MODEL_COLORS.length] ?? "#71717a",
      tokens: entry.tokens,
    }));
  }, [stats]);

  const summary = stats
    ? [
        {
          label: "累计 Token 数",
          value: formatTokens(stats.totals.tokens),
          hint: undefined as string | undefined,
        },
        {
          label: "峰值 Token 数",
          value: formatTokens(stats.peakDayTokens),
          hint: "单日 token 用量的峰值",
        },
        {
          label: "最长聊天时长",
          value: formatDuration(stats.longestSessionSeconds),
          hint: "单条对话从第一条消息到最后一条消息的跨度",
        },
        {
          label: "当前连续天数",
          value: `${stats.currentStreakDays} 天`,
          hint: undefined as string | undefined,
        },
        {
          label: "最长连续天数",
          value: `${stats.longestStreakDays} 天`,
          hint: undefined as string | undefined,
        },
      ]
    : [];

  return (
    <div className={SETTINGS_SECTION_GAP}>
      <div className="mb-2 flex items-center gap-3">
        <h3 className={SETTINGS_TITLE_TEXT}>使用统计</h3>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          应用用量
        </span>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {loading && !stats ? (
        <p className="text-xs text-muted-foreground">正在加载…</p>
      ) : null}

      {stats ? (
        <>
          {/* 汇总条：一张卡、五格、竖分隔线（参考图同款） */}
          <div className="flex divide-x rounded-xl border bg-card">
            {summary.map((item) => (
              <div
                key={item.label}
                className="min-w-0 flex-1 px-3 py-3 text-center"
                title={item.hint}
              >
                <div className="text-base font-medium tabular-nums">
                  {item.value}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          <Card
            title="Token 活动"
            action={
              <SegmentedToggle
                ariaLabel="活动视图"
                options={[
                  { value: "daily" as const, label: "每日" },
                  { value: "cumulative" as const, label: "累计" },
                ]}
                value={heatMode}
                onChange={setHeatMode}
              />
            }
          >
            <Heatmap heatmap={stats.heatmap ?? []} mode={heatMode} />
          </Card>

          {/* 时间范围：裸行（参考图：标签在左、切换在右，不套卡片） */}
          <div className="flex items-center justify-between">
            <h4 className="text-sm text-muted-foreground">时间范围</h4>
            <SegmentedToggle
              ariaLabel="统计时间范围"
              options={[
                { value: 7 as const, label: "近 7 日" },
                { value: 30 as const, label: "近 30 日" },
              ]}
              value={days}
              onChange={setDays}
            />
          </div>

          <Card title="每日 Token 趋势图">
            <TrendChart
              dates={stats.daily.map((day) => day.date)}
              series={trendSeries}
            />
          </Card>

          <Card title="模型用量">
            <UsageDonut byModel={stats.byModel} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
