/**
 * zcode 照搬：`@/app-shell/workflow-artifacts/presets/ArtifactTable.tsx`（references/zcode/packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactTable.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */
/**
 * `table` 预置渲染器：一行一条（或按 `key` upsert 的一行一实体）。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的行数 + 前 3 行；
 * - 全尺寸：`workflow-artifact` tab 里的完整表格，表头吸顶、自带纵横滚动。
 *
 * 刻意**不复用** `MarkdownTable`：那是一份 1400 行、带排序 / 选区 / 复制 / 虚拟化的富组件，
 * 为一张只读投影表把它整棵拖进来不划算（spec 允许「或轻量表格，实现期定」）。行数用一个
 * 固定上限兜住 DOM 规模，超出的部分在表头的计数里如实呈现——这比装一个虚拟器便宜得多，
 * 而条目本身在投影侧已经是有界的。
 */

import {
  type ArtifactItem,
  applyArtifactItems,
} from "@zui/app-shell/workflow-artifacts/presets/apply";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  type PresetLabels,
  REVEAL_ANIMATION_CLASS,
} from "@zui/app-shell/workflow-artifacts/presets/parts";
import type { TableSpec } from "@zui/app-shell/workflow-artifacts/presets/spec";
import { cn } from "@zui/components/lib/utils";
import { memo, useMemo } from "react";

/** 小卡片里只露前几行——它是一个「有东西了」的信号，不是阅读面。 */
const COMPACT_ROWS = 3;
/** 全尺寸下真正挂进 DOM 的行数上限；再多也读不过来，且 DOM 规模必须有界。 */
const ARTIFACT_TABLE_MAX_ROWS = 200;

export const ArtifactTable = memo(function ArtifactTable({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: TableSpec;
  items: readonly ArtifactItem[];
  compact?: boolean | undefined;
  labels: PresetLabels;
  className?: string | undefined;
}) {
  const model = useMemo(
    () => applyArtifactItems("table", spec, items),
    [spec, items],
  );
  const total = model.rows.length;
  const visible = compact
    ? model.rows.slice(0, COMPACT_ROWS)
    : model.rows.slice(0, ARTIFACT_TABLE_MAX_ROWS);

  if (total === 0) {
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

  const count = (
    <span
      className="shrink-0 font-mono text-ui-xs text-foreground-subtlest tabular-nums"
      data-testid="artifact-table-count"
    >
      {labels.itemsCount(total)}
    </span>
  );

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-table">
      {compact ? (
        <div className="mb-1.5 flex justify-end">{count}</div>
      ) : (
        <PresetHeading
          className="mb-3"
          description={spec.description}
          title={spec.title}
          trailing={count}
        />
      )}
      {/* 宽内容在自己的容器里横向滚动，绝不把面板本身撑出横向滚动条（DESIGN.md 响应式）。 */}
      <div
        className={cn(
          "min-w-0 overflow-auto rounded-lg border border-border",
          compact ? "" : "max-h-128",
        )}
      >
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {model.columns.map((column) => (
                <th
                  className="whitespace-nowrap border-b border-border px-2 py-1.5 text-ui-xs font-medium text-foreground-subtle"
                  key={column.field}
                  scope="col"
                >
                  {fieldHeading(column.label, column.unit)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              // 身份是行 id（spec 的 key 值，或 journal 的 siteId@ordinal）——它稳定，
              // 于是只有**新行**会播揭示动画，既有行原地更新不闪。
              <tr
                className={cn(
                  "border-b border-border/60 last:border-b-0 hover:bg-hover",
                  REVEAL_ANIMATION_CLASS,
                )}
                data-testid="artifact-table-row"
                key={row.id}
              >
                {row.cells.map((cell, index) => (
                  <td
                    className="max-w-56 truncate px-2 py-1 font-mono text-ui-xs text-foreground"
                    key={model.columns[index]?.field ?? index}
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
