/**
 * KenFutWork 宿主适配：composer 工具条的上下文容量显示换回旧版 16px 圆环 + HoverCard
 * （G6/Q13）。经 vite/vitest 别名替换 `@zui/chat-input-toolbar/contextUsage.js`——
 * display.tsx 对本模块的三处 re-export（ChatContextUsage / getContextCompressionCommand /
 * getRenderableTaskUsage）签名保持不变。
 *
 * 数据链：服务端 run.usage 事件带 contextWindowTokens（模型目录+兜底表解析后下发）→
 * conversation 快照 usage.contextWindow → 工具条 taskUsage {used, size, cache}。
 * 展示口径全部复用 web 层 `lib/context-usage.ts`（R4-1 沉淀：无数据不显示 0%、
 * 窗口未知不编分母、命中率按 token 加权）。
 */
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@zui/components/ui/hover-card.js";
import {
  contextUsageView,
  type RunUsageSnapshot,
} from "../../../../lib/context-usage.js";

interface AdapterTaskUsage {
  used: number;
  size: number;
  cache?:
    | (Record<string, unknown> & { hitRate?: number | null })
    | undefined;
  breakdown?: ReadonlyArray<{ source: string; chars: number }> | undefined;
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

function toRunUsageSnapshot(
  taskUsage: AdapterTaskUsage,
): RunUsageSnapshot | null {
  // 窗口未知（size=0）不算「无数据」：仍给绝对量读数（usageLine 兜底文案），
  // 只有 used 非法/为零才视为无数据。
  if (
    !Number.isFinite(taskUsage.used) ||
    taskUsage.used <= 0
  ) {
    return null;
  }
  const cache = taskUsage.cache as
    | {
        inputTokens?: number;
        cacheReadTokens?: number;
        totalInputTokens?: number;
        totalCacheReadTokens?: number;
        hitRate?: number | null;
      }
    | undefined;
  return {
    inputTokens: taskUsage.used,
    outputTokens: 0,
    ...(typeof cache?.cacheReadTokens === "number"
      ? { cachedInputTokens: cache.cacheReadTokens }
      : {}),
    ...(typeof cache?.totalInputTokens === "number"
      ? { runInputTokens: cache.totalInputTokens }
      : {}),
    ...(typeof cache?.totalCacheReadTokens === "number"
      ? { runCachedInputTokens: cache.totalCacheReadTokens }
      : {}),
  };
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
  const usage = toRunUsageSnapshot(taskUsage ?? { used: 0, size: 0 });
  // size=0 = 服务端没解析到窗口（快照 schema 要求 number）：只给绝对量，不编分母。
  const window = taskUsage && taskUsage.size > 0 ? taskUsage.size : null;
  const view = contextUsageView(usage, window);

  return (
    <HoverCard openDelay={0} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="上下文容量"
          title={view.usageFineLine ?? view.usageLine ?? "上下文容量"}
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
            {view.usageFineLine ?? view.usageLine ?? "本轮暂无用量"}
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
