/**
 * zcode 照搬：`@/app-shell/workflow-artifacts/presets/ArtifactMetrics.tsx`（references/zcode/packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactMetrics.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */
/**
 * `metrics` 预置渲染器：一排瓦片，每块显示**最后一条带该字段**的条目里的值。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的瓦片行，横向排，只有值和标签；
 * - 全尺寸：`workflow-artifact` tab 里的网格，值更大、带单位。
 */

import {
  type ArtifactItem,
  applyArtifactItems,
  type MetricTileModel,
} from "@zui/app-shell/workflow-artifacts/presets/apply";
import {
  PresetEmpty,
  PresetHeading,
  type PresetLabels,
  REVEAL_ANIMATION_CLASS,
} from "@zui/app-shell/workflow-artifacts/presets/parts";
import type { MetricsSpec } from "@zui/app-shell/workflow-artifacts/presets/spec";
import { cn } from "@zui/components/lib/utils";
import { memo, useMemo } from "react";

/** 还没有值的瓦片。用破折号而不是 0——「没测到」和「测出来是 0」不是一回事。 */
const EMPTY_VALUE = "—";

function MetricTile({
  tile,
  compact,
}: {
  tile: MetricTileModel;
  compact: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5",
        compact ? "" : "rounded-lg border border-border bg-surface px-3 py-2",
      )}
      data-testid="artifact-metric-tile"
      data-metric-field={tile.field}
    >
      <span
        className={cn(
          "truncate text-foreground-subtlest",
          compact ? "text-ui-xs" : "text-ui-sm",
        )}
        title={tile.label}
      >
        {tile.label}
      </span>
      <span className="flex min-w-0 items-baseline gap-1">
        {/* key 带上 sequence：值换了就重新挂载，于是刷新那一下会播一次揭示动画；
            值没换的瓦片保持同一个 DOM 节点，不会跟着别的瓦片一起闪。 */}
        <span
          className={cn(
            "truncate font-mono font-medium text-foreground tabular-nums",
            compact ? "text-ui-sm" : "text-ui-lg",
            REVEAL_ANIMATION_CLASS,
          )}
          key={`${tile.field}:${tile.sequence ?? "none"}`}
          data-testid="artifact-metric-value"
          title={tile.value ?? EMPTY_VALUE}
        >
          {tile.value ?? EMPTY_VALUE}
        </span>
        {tile.unit && tile.value !== undefined ? (
          <span
            className={cn(
              "shrink-0 text-foreground-subtle",
              compact ? "text-ui-xs" : "text-ui-sm",
            )}
          >
            {tile.unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export const ArtifactMetrics = memo(function ArtifactMetrics({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: MetricsSpec;
  items: readonly ArtifactItem[];
  compact?: boolean | undefined;
  labels: PresetLabels;
  className?: string | undefined;
}) {
  const model = useMemo(
    () => applyArtifactItems("metrics", spec, items),
    [spec, items],
  );
  const hasAnyValue = model.metrics.some((tile) => tile.value !== undefined);

  if (!hasAnyValue) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading
            className="mb-3"
            description={spec.description}
            title={spec.title}
          />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  return (
    <div className={className} data-testid="artifact-metrics">
      {compact ? null : (
        <PresetHeading
          className="mb-3"
          description={spec.description}
          title={spec.title}
        />
      )}
      {/* 窄侧板（~372px）里瓦片会换行，不横向溢出；全尺寸下按内容宽度自动铺满。 */}
      <div
        className={cn(
          "grid gap-2",
          compact
            ? "grid-cols-[repeat(auto-fill,minmax(6rem,1fr))]"
            : "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]",
        )}
      >
        {model.metrics.map((tile) => (
          <MetricTile compact={compact} key={tile.field} tile={tile} />
        ))}
      </div>
    </div>
  );
});
