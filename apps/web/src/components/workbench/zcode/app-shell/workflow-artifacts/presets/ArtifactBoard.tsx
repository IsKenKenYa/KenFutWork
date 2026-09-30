/**
 * zcode 照搬：`@/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx`（references/zcode/packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */
/**
 * `board` 预置渲染器：按 `status` 分列的卡片墙，卡片按 `key` upsert。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的**各列计数**（一眼看出「12 个里 3 个还没过」）；
 * - 全尺寸：`workflow-artifact` tab 里的列 + 卡片。
 *
 * **无拖拽**：这是 journal 的只读投影，卡片的位置由脚本 `report` 出来的 status 决定；
 * 让用户拖动会凭空造出一个「谁是权威」的问题（v1 明确不做交互式筛选 / 排序）。
 */

import {
  type ArtifactItem,
  applyArtifactItems,
  type BoardCardModel,
  type BoardColumnModel,
} from "@zui/app-shell/workflow-artifacts/presets/apply";
import {
  PresetEmpty,
  PresetHeading,
  type PresetLabels,
  REVEAL_ANIMATION_CLASS,
} from "@zui/app-shell/workflow-artifacts/presets/parts";
import type { BoardSpec } from "@zui/app-shell/workflow-artifacts/presets/spec";
import { cn } from "@zui/components/lib/utils";
import { memo, useMemo } from "react";

function columnLabel(column: BoardColumnModel, labels: PresetLabels): string {
  return column.other ? labels.otherColumn : column.id;
}

function BoardCard({ card }: { card: BoardCardModel }) {
  return (
    // key 是卡片 id（稳定），所以只有**新卡**播揭示动画；状态变化让卡换列，但不重播。
    <div
      className={cn(
        "rounded-lg border border-card-border bg-card px-2 py-1.5",
        REVEAL_ANIMATION_CLASS,
      )}
      data-card-id={card.id}
      data-testid="artifact-board-card"
    >
      <div
        className="truncate text-ui-sm font-medium text-foreground"
        title={card.title}
      >
        {card.title}
      </div>
      {card.details.length > 0 ? (
        <dl className="mt-1 space-y-0.5">
          {card.details.map((detail) => (
            <div
              className="flex min-w-0 items-baseline gap-1.5"
              key={detail.label}
            >
              <dt className="shrink-0 text-ui-xs text-foreground-subtlest">
                {detail.label}
              </dt>
              <dd
                className="min-w-0 flex-1 truncate text-right font-mono text-ui-xs text-foreground-subtle"
                title={detail.value}
              >
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export const ArtifactBoard = memo(function ArtifactBoard({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: BoardSpec;
  items: readonly ArtifactItem[];
  compact?: boolean | undefined;
  labels: PresetLabels;
  className?: string | undefined;
}) {
  const model = useMemo(
    () => applyArtifactItems("board", spec, items),
    [spec, items],
  );

  if (model.cardCount === 0) {
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

  if (compact) {
    return (
      <div
        className={cn("flex flex-wrap gap-1.5", className)}
        data-testid="artifact-board-compact"
      >
        {model.columns.map((column) => (
          <span
            className="flex min-w-0 items-baseline gap-1 rounded-md bg-surface px-1.5 py-0.5"
            data-column-id={column.id}
            data-testid="artifact-board-column-count"
            key={column.id}
          >
            <span className="truncate text-ui-xs text-foreground-subtle">
              {columnLabel(column, labels)}
            </span>
            <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
              {column.cards.length}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-board">
      <PresetHeading
        className="mb-3"
        description={spec.description}
        title={spec.title}
        trailing={
          <span className="font-mono text-ui-xs text-foreground-subtlest tabular-nums">
            {labels.itemsCount(model.cardCount)}
          </span>
        }
      />
      {/* 列在自己的容器里横向滚动；窄面板下也不改变组件身份，只是要划一下。 */}
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {model.columns.map((column) => (
          <section
            className="flex w-44 shrink-0 flex-col gap-1.5 rounded-lg bg-surface p-2"
            data-column-id={column.id}
            data-testid="artifact-board-column"
            key={column.id}
          >
            <header className="flex items-baseline justify-between gap-2">
              <h4
                className="min-w-0 truncate text-ui-sm font-medium text-foreground"
                title={columnLabel(column, labels)}
              >
                {columnLabel(column, labels)}
              </h4>
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest tabular-nums">
                {column.cards.length}
              </span>
            </header>
            {column.cards.map((card) => (
              <BoardCard card={card} key={card.id} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
});
