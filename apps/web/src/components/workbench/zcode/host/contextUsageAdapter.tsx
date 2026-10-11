/**
 * KenFutWork 宿主适配：composer 工具条的上下文容量显示换回旧版 16px 圆环 + HoverCard
 * （G6/Q13）。经 vite/vitest 别名替换 `@zui/chat-input-toolbar/contextUsage.js`——
 * display.tsx 对本模块的三处 re-export（ChatContextUsage / getContextCompressionCommand /
 * getRenderableTaskUsage）签名保持不变。
 *
 * 数据链：服务端 run.usage 事件带 contextWindowTokens（模型目录+兜底表解析后下发）→
 * conversation 快照 usage.contextWindow → 工具条 taskUsage {used, size, cache}。
 *
 * 展示口径与 web 层 `src/lib/context-usage.ts`（R4-1 沉淀）一致；因 host tsconfig
 * rootDir=host 不能跨包导入，此处内联等价实现（无数据不显示 0%、窗口未知不编分母、
 * 命中率按 token 加权）——改口径时两处同步。
 */
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@zui/components/ui/hover-card.js";

interface AdapterTaskUsage {
  used: number;
  size: number;
  cache?:
    | (Record<string, unknown> & { hitRate?: number | null })
    | undefined;
  breakdown?: ReadonlyArray<{ source: string; chars: number }> | undefined;
}

/** token 数的中文习惯缩写（61.4万 / 100万）。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 100_000_000) return `${trimZero(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${trimZero(value / 10_000)}万`;
  return String(Math.round(value));
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

interface UsageView {
  percent: number | null;
  fineLine: string | null;
  line: string | null;
  cacheHitLabel: string | null;
  cacheHitPercent: number | null;
}

/** R4-1 口径的内联版：窗口未知不编分母；命中率 = run 累计命中 ÷ run 累计输入。 */
function usageView(
  used: number,
  window: number | null,
  cache?: {
    cacheReadTokens?: number;
    totalInputTokens?: number;
    totalCacheReadTokens?: number;
  },
): UsageView {
  if (used <= 0) {
    return {
      percent: null,
      fineLine: null,
      line: null,
      cacheHitLabel: null,
      cacheHitPercent: null,
    };
  }
  const rawPercent = window === null ? null : (used / window) * 100;
  const percent =
    rawPercent === null ? null : Math.min(100, Math.round(rawPercent * 10) / 10);
  const finePercent =
    rawPercent === null
      ? null
      : rawPercent >= 100
        ? "100"
        : rawPercent.toFixed(2).replace(/\.?0+$/, "");
  const runInput = cache?.totalInputTokens;
  const runCached = cache?.totalCacheReadTokens;
  const hitRate =
    typeof runInput === "number" && runInput > 0 && typeof runCached === "number"
      ? (runCached / runInput) * 100
      : null;
  return {
    percent,
    fineLine:
      finePercent === null || window === null
        ? null
        : `${formatTokens(used)}/${formatTokens(window)}（${finePercent}%）`,
    line:
      window === null
        ? `${formatTokens(used)}（窗口未知）`
        : `${formatTokens(used)}/${formatTokens(window)}（${percent ?? 0}%）`,
    cacheHitLabel:
      hitRate === null ? null : `${Math.round(hitRate * 10) / 10}%`,
    cacheHitPercent: hitRate === null ? null : Math.min(100, hitRate),
  };
}

/** taskUsage 为空或非法时不渲染（不把兜底 0 当真实占用）。 */
export function getRenderableTaskUsage<T extends { used: number; size: number }>(
  taskUsage: T | null,
): T | null {
  if (
    !taskUsage ||
    !Number.isFinite(taskUsage.used) ||
    !Number.isFinite(taskUsage.size) ||
    taskUsage.used <= 0 ||
    taskUsage.size <= 0
  ) {
    return null;
  }
  return taskUsage;
}

export function getContextCompressionCommand(): string {
  return "/compact";
}

export function ChatContextUsage({
  taskUsage,
}: {
  codingPlanUsageRemaining?: unknown;
  startPlanBalance?: unknown;
  taskUsage: AdapterTaskUsage | null;
  selectedProvider?: unknown;
  intl?: unknown;
  locale?: unknown;
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
}) {
  const cache = taskUsage?.cache as
    | {
        cacheReadTokens?: number;
        totalInputTokens?: number;
        totalCacheReadTokens?: number;
      }
    | undefined;
  // size=0 = 服务端没解析到窗口（快照 schema 要求 number）：只给绝对量，不编分母。
  const window = taskUsage && taskUsage.size > 0 ? taskUsage.size : null;
  const view = usageView(taskUsage?.used ?? 0, window, cache);

  return (
    <HoverCard openDelay={0} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="上下文容量"
          title={view.fineLine ?? view.line ?? "上下文容量"}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors outline-none hover:bg-hover"
          data-testid="context-usage-ring"
        >
          <ContextRing percent={view.percent} />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 rounded-xl border bg-popover p-3 text-xs text-popover-foreground shadow-md"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">上下文容量</span>
          <span className="tabular-nums">
            {view.fineLine ?? view.line ?? "本轮暂无用量"}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hover">
          <div
            className="h-full rounded-l-full bg-foreground/70"
            style={{ width: `${view.percent ?? 0}%` }}
          />
        </div>
        <div className="mt-3 border-t pt-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">平均缓存命中率</span>
            <span className="tabular-nums">
              {view.cacheHitLabel ?? "模型未提供"}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-hover">
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${view.cacheHitPercent ?? 0}%` }}
            />
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** 16px 细环：弧长 = 已用百分比（无数据只画空轨道，不编弧）。 */
function ContextRing({ percent }: { percent: number | null }) {
  const size = 16;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedRatio =
    percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="-rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-border"
      />
      {percent !== null && usedRatio > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={`${circumference * usedRatio} ${circumference}`}
          className="stroke-muted-foreground"
        />
      ) : null}
    </svg>
  );
}
