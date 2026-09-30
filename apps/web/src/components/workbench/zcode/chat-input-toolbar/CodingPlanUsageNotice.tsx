/**
 * zcode 照搬：`@/chat-input-toolbar/CodingPlanUsageNotice.tsx`（references/zcode/packages/ui/src/chat-input-toolbar/CodingPlanUsageNotice.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import { InfoIcon, RefreshCwIcon } from "lucide-react";

export function CodingPlanUsageNotice({
  message,
  onRefresh,
  refreshLabel,
}: {
  message: string;
  onRefresh?: (() => void | Promise<void>) | undefined;
  refreshLabel: string;
}) {
  return (
    <div
      data-coding-plan-usage-notice="true"
      className="col-span-full flex w-full min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-2 text-ui-base text-foreground-subtle"
    >
      <InfoIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-foreground">{message}</span>
      {onRefresh ? (
        <button
          type="button"
          aria-label={refreshLabel}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onRefresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
