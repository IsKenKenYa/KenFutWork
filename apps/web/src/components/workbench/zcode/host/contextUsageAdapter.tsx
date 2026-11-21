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
  cache?: (Record<string, unknown> & { hitRate?: number | null }) | undefined;
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
    };
  }
  const rawPercent = window === null ? null : (used / window) * 100;
  const percent =
    rawPercent === null
      ? null
      : Math.min(100, Math.round(rawPercent * 10) / 10);
  const finePercent =
    rawPercent === null
      ? null
      : rawPercent >= 100
        ? "100"
        : rawPercent.toFixed(2).replace(/\.?0+$/, "");
  const runInput = cache?.totalInputTokens;
  const runCached = cache?.totalCacheReadTokens;
  const hitRate =
    typeof runInput === "number" &&
    runInput > 0 &&
    typeof runCached === "number"
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
  };
}

/** taskUsage 为空或非法时不渲染（不把兜底 0 当真实占用）。 */
export function getRenderableTaskUsage<
  T extends { used: number; size: number },
>(taskUsage: T | null): T | null {
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
  const breakdown = taskUsage?.breakdown ?? [];

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
      {/* 旧版面板形态（用户点名要的那一版）：浅色卡片、蓝色进度条、来源明细。
          不传 `border`：HoverCardContent 自身已有 ring-1 描边，再叠一层 border 就是
          用户看到的「大黑边」双描边。宽度按内容，不再压成固定 72。 */}
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 rounded-2xl bg-popover px-4 py-3.5 text-ui-base shadow-lg"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ui-base font-medium text-foreground">
            上下文容量
          </span>
          <span className="text-ui-sm tabular-nums text-foreground-subtle">
            {view.fineLine ?? view.line ?? "本轮暂无用量"}
          </span>
        </div>
        <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-hover">
          <div
            className="h-full rounded-full bg-sky-500"
            style={{ width: `${view.percent ?? 0}%` }}
          />
        </div>
        {breakdown.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {breakdown.map((item) => (
              <li
                key={item.source}
                className="flex items-center justify-between gap-3 text-ui-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                  <span className="truncate text-foreground">
                    {BREAKDOWN_LABELS[item.source] ?? item.source}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {breakdownPercent(item, breakdown)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 border-t border-border pt-2.5">
          <div className="flex items-center justify-between gap-3 text-ui-sm">
            <span className="text-foreground-subtle">平均缓存命中率</span>
            <span className="tabular-nums text-foreground">
              {view.cacheHitLabel ?? "模型未提供"}
            </span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** 上下文来源 → 界面标签（与服务端 `contextWindow.breakdown[].source` 一一对应）。 */
const BREAKDOWN_LABELS: Record<string, string> = {
  messages: "消息",
  system_prompt: "系统提示词",
  meta_user_context: "其他",
  skills: "技能",
  tool_prompt: "工具提示",
  system_tool_schemas: "系统工具",
  mcp_tool_schemas: "MCP 工具",
};

/**
 * 单个来源占本轮全部上下文的百分比。
 *
 * 分母用**各来源之和**而不是窗口大小：明细要回答「这一轮里谁占得多」，
 * 用窗口做分母时小来源永远显示 0.0%，看不出差别。
 */
function breakdownPercent(
  item: { chars: number; source: string },
  all: ReadonlyArray<{ chars: number; source: string }>,
): string {
  const total = all.reduce((sum, entry) => sum + Math.max(0, entry.chars), 0);
  if (!Number.isFinite(total) || total <= 0) return "0.0%";
  const share = (Math.max(0, item.chars) / total) * 100;
  return `${share.toFixed(1)}%`;
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
          strokeLinecap="round"
          strokeDasharray={`${circumference * usedRatio} ${circumference}`}
          className="stroke-sky-500"
        />
      ) : null}
    </svg>
  );
}
