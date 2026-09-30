/**
 * zcode 照搬：`@/ToolCallBlocks/renderers.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 * 适配注记：接口可选属性放宽 | undefined 以等价 zcode tsconfig 行为（exactOptionalPropertyTypes）。
 */

import { FlipMetricValue } from "@zui/components/ui/flip-metric-value";
import {
  FileDisplayIcon,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
} from "@zui/lib/fileDisplay";
import { getPathLeaf } from "@zui/lib/path";
import { inferEditOperation } from "@zui/ToolCallBlocks/fileSummaries";
import type {
  EditKindLabelId,
  EditKindSource,
  EditOperationKind,
  RawToolCallFileSummary,
} from "@zui/ToolCallBlocks/fileSummaryTypes";

export function renderDiffCount(
  changeStat?: {
    added: number;
    removed: number;
  },
  options?: { animateInitial?: boolean | undefined },
) {
  if (!changeStat) {
    return null;
  }

  if (changeStat.added <= 0 && changeStat.removed <= 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {changeStat.added > 0 ? (
        <span
          aria-label={`+${changeStat.added}`}
          className="inline-flex items-center text-diff-added"
          role="text"
          title={`+${changeStat.added}`}
        >
          +
          {/* 性能修复：投影已按秒给出真实统计，数字只做一次短翻页，不再逐行 rAF 追赶。 */}
          <FlipMetricValue
            value={String(changeStat.added)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
      {changeStat.removed > 0 ? (
        <span
          aria-label={`-${changeStat.removed}`}
          className="inline-flex items-center text-diff-removed"
          role="text"
          title={`-${changeStat.removed}`}
        >
          -
          <FlipMetricValue
            value={String(changeStat.removed)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
    </span>
  );
}

export function renderFileChip({
  summary,
  clickable = false,
  onClick,
  title,
  basePath,
}: {
  summary: RawToolCallFileSummary;
  clickable?: boolean | undefined;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  basePath?: string | undefined;
}) {
  const descriptor = resolveFileDisplayDescriptor(summary.path, {
    basePath,
  });
  const chipTitle = title ?? getFileDisplayPath(summary.path, basePath);

  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle hover:underline"
        title={chipTitle}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon
          src={descriptor.fileIconSrc}
          size={16}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 truncate text-foreground-subtle">
          {getPathLeaf(summary.path)}
        </span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
      title={chipTitle}
    >
      <FileDisplayIcon
        src={descriptor.fileIconSrc}
        size={16}
        className="size-4 shrink-0"
      />
      <span className="min-w-0 truncate">{getPathLeaf(summary.path)}</span>
    </span>
  );
}

export function renderFilePath(
  path: string | null | undefined,
  basePath?: string,
) {
  if (!path) {
    return null;
  }

  return (
    <span className="min-w-0 truncate text-foreground-subtlest @max-[360px]/conversation:hidden">
      {/* 窄会话流里父目录会与文件名争抢空间，Read/Edit 最终只剩动作标签和省略号。
          小容器隐藏次要路径，让文件名继续承担主识别信息。 */}
      {getFileDisplayPath(path, basePath)}
    </span>
  );
}

export function getEditKindLabelMessageId(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  isRunning: boolean,
  source?: EditKindSource,
): EditKindLabelId {
  const inferredOperation = inferEditOperation(
    operationKinds,
    actionLabels,
    source,
  );

  if (inferredOperation === "write") {
    return isRunning
      ? "chat.toolCall.edit.writing"
      : "chat.toolCall.kind.write";
  }

  if (inferredOperation === "delete") {
    return isRunning
      ? "chat.toolCall.edit.deleting"
      : "chat.toolCall.kind.delete";
  }

  if (actionLabels.length === 0) {
    return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
  }

  return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
}

export function renderJoinedFileChips(
  summaries: RawToolCallFileSummary[],
  options: {
    clickable?: boolean | undefined;
    onClick?: ((summary: RawToolCallFileSummary) => void) | undefined;
    basePath?: string | undefined;
  } = {},
) {
  return (
    <div className="inline-flex min-w-0 items-center">
      {summaries.map((summary, index) => (
        <span key={summary.path} className="inline-flex min-w-0 items-center">
          {index > 0 ? (
            <span className="mx-1 text-foreground-subtlest">,</span>
          ) : null}
          {renderFileChip({
            summary,
            clickable: options.clickable,
            basePath: options.basePath,
            onClick: options.onClick
              ? () => options.onClick?.(summary)
              : undefined,
          })}
        </span>
      ))}
    </div>
  );
}
