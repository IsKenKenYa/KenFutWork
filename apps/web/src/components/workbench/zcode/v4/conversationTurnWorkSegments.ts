/**
 * zcode 照搬：`@/v4/conversationTurnWorkSegments.ts`（references/zcode/packages/ui/src/v4/conversationTurnWorkSegments.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为；上游依赖运行时恒有值）。
 */
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zui/lib/zcode-shared/zcode-protocol-v4";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroupFlowItems,
} from "@zui/v4/conversationCuaGroups";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
} from "@zui/v4/conversationTurnFlowItems";
import { buildConversationFlowItems } from "@zui/v4/conversationTurnFlowItems";

export interface ConversationTurnWorkStatus {
  state: "running" | "completed" | "interrupted";
  durationMs?: number | undefined;
}

export interface ConversationTurnWorkSegment {
  key: string;
  triggerRow?: UserInputRow | undefined;
  flowItems: ConversationTurnFlowItem[];
  assistantWorkRows: AssistantWorkRow[];
  assistantHistoryRows: AssistantWorkRow[];
  assistantFollowingRows: AssistantWorkRow[];
  assistantHistoryDefaultOpen: boolean;
  workStatus?: ConversationTurnWorkStatus | undefined;
}

export function resolveConversationTurnWorkStatus(
  header: TurnHeaderRow | undefined,
  workRows: readonly AssistantWorkRow[],
  isRunning: boolean,
  durationMs: number | undefined,
  isInterrupted = false,
): ConversationTurnWorkStatus | undefined {
  if (header?.executionKind === "controlOnly") return undefined;
  const hasWork =
    isRunning ||
    workRows.length > 0 ||
    (header?.executionKind === "agent"
      ? durationMs !== undefined
      : (durationMs ?? 0) > 0);
  if (!hasWork) return undefined;
  return {
    state: isRunning ? "running" : isInterrupted ? "interrupted" : "completed",
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export function resolveConversationTurnWorkDurationMs(
  header: TurnHeaderRow | undefined,
  options: { nowMs?: number | undefined },
  isRunning: boolean,
): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined)
    return Math.max(header.endedAt - header.startedAt, 0);
  // UI 每秒传入 nowMs 只用于运行中“工作中 N 秒”；完成态缺少
  // activeMs/endedAt 时不能继续吃当前时钟，否则历史“已工作”会随时间增长。
  if (isRunning && options.nowMs !== undefined) {
    return Math.max(options.nowMs - header.startedAt, 0);
  }
  return undefined;
}

interface DraftVisualWorkSegment {
  orderedRows: ConversationRow[];
  triggerRow?: UserInputRow | undefined;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function splitVisualWorkSegments(
  rows: readonly ConversationRow[],
): DraftVisualWorkSegment[] {
  const segments: DraftVisualWorkSegment[] = [];
  let current: DraftVisualWorkSegment = { orderedRows: [] };
  for (const row of rows) {
    if (
      isUserInputRow(row) &&
      row.guided === true &&
      current.orderedRows.length > 0
    ) {
      segments.push(current);
      current = { orderedRows: [], triggerRow: row };
    }
    current.orderedRows.push(row);
  }
  if (current.orderedRows.length > 0) segments.push(current);
  return segments;
}

function resolveSegmentDurationMs(options: {
  header?: TurnHeaderRow | undefined;
  segmentIndex: number;
  triggerRow?: UserInputRow | undefined;
  nextTriggerRow?: UserInputRow | undefined;
  segmentRunning: boolean;
  segmentCount: number;
  nowMs?: number | undefined;
}): number | undefined {
  const fact =
    (options.triggerRow?.entityId
      ? options.header?.workSegments?.find(
          (candidate) =>
            candidate.triggerEntityId === options.triggerRow?.entityId,
        )
      : undefined) ?? options.header?.workSegments?.[options.segmentIndex];
  if (fact?.activeMs !== undefined) return fact.activeMs;
  if (fact?.endedAt !== undefined)
    return Math.max(0, fact.endedAt - fact.startedAt);
  if (fact && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - fact.startedAt);
  }
  if (options.segmentCount === 1) {
    return resolveConversationTurnWorkDurationMs(
      options.header,
      { nowMs: options.nowMs },
      options.segmentRunning,
    );
  }
  // 兼容旧 guide snapshot：新 CLI 会下发 workSegments；仅旧数据缺事实时才按
  // guided row 的稳定时间边界恢复，避免刷新后又退回整个 turn 的单一工时。
  const startedAt = options.triggerRow?.createdAt ?? options.header?.startedAt;
  const endedAt = options.nextTriggerRow?.createdAt ?? options.header?.endedAt;
  if (startedAt !== undefined && endedAt !== undefined)
    return Math.max(0, endedAt - startedAt);
  if (
    startedAt !== undefined &&
    options.segmentRunning &&
    options.nowMs !== undefined
  ) {
    return Math.max(0, options.nowMs - startedAt);
  }
  return undefined;
}

export function buildConversationTurnWorkSegments(options: {
  key: string;
  header?: TurnHeaderRow | undefined;
  orderedRows: readonly ConversationRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  latestAssistantTextRow?: AssistantTextRow | undefined;
  isRunning: boolean;
  isLastTurn: boolean;
  isInterrupted: boolean;
  forceOpenHistory: boolean;
  timelineOnly: boolean;
  nowMs?: number | undefined;
}): ConversationTurnWorkSegment[] {
  const visualDrafts = splitVisualWorkSegments(options.orderedRows);
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  return visualDrafts.map((segment, segmentIndex) => {
    const segmentAssistantRows = segment.orderedRows.filter(isAssistantWorkRow);
    const segmentTailRows = segmentAssistantRows.filter((row) =>
      tailRowIds.has(row.rowId),
    );
    const segmentFlowRows = segmentAssistantRows.filter(
      (row) => !tailRowIds.has(row.rowId),
    );
    const lastSegmentFlowRow = segmentFlowRows.at(-1);
    const segmentCompleted =
      segmentIndex < visualDrafts.length - 1 || !options.isRunning;
    const productLatestAssistantTextRow = options.latestAssistantTextRow
      ? segmentFlowRows.find(
          (row) => row.rowId === options.latestAssistantTextRow?.rowId,
        )
      : undefined;
    const visibleAssistantTextRow =
      productLatestAssistantTextRow &&
      isAssistantTextRow(productLatestAssistantTextRow)
        ? productLatestAssistantTextRow
        : segmentCompleted &&
            lastSegmentFlowRow &&
            isAssistantTextRow(lastSegmentFlowRow)
          ? lastSegmentFlowRow
          : undefined;
    const visibleAssistantIndex = visibleAssistantTextRow
      ? segmentFlowRows.findIndex(
          (row) => row.rowId === visibleAssistantTextRow.rowId,
        )
      : -1;
    const segmentHistoryRows = options.timelineOnly
      ? []
      : visibleAssistantIndex < 0
        ? segmentFlowRows
        : segmentFlowRows.slice(0, visibleAssistantIndex);
    const segmentFollowingRows =
      visibleAssistantIndex < 0
        ? []
        : segmentFlowRows.slice(visibleAssistantIndex + 1);
    const segmentRunning =
      segmentIndex === visualDrafts.length - 1 && options.isRunning;
    const segmentDurationMs = resolveSegmentDurationMs({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      nextTriggerRow: visualDrafts[segmentIndex + 1]?.triggerRow,
      segmentRunning,
      segmentCount: visualDrafts.length,
      nowMs: options.nowMs,
    });
    const segmentWorkStatus = resolveConversationTurnWorkStatus(
      options.header,
      segmentFlowRows,
      segmentRunning,
      segmentDurationMs,
      options.isInterrupted && segmentIndex === visualDrafts.length - 1,
    );
    const segmentKey =
      segmentIndex === 0
        ? options.key
        : `${options.key}:guide:${segment.triggerRow?.entityId ?? segment.triggerRow?.rowId ?? segmentIndex}`;
    const flowItems = buildConversationFlowItems({
      orderedRows: segment.orderedRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantTailRows: segmentTailRows,
      ...(visibleAssistantTextRow ? { visibleAssistantTextRow } : {}),
      ...(options.latestAssistantTextRow
        ? { latestAssistantTextRow: options.latestAssistantTextRow }
        : {}),
      timelineOnly: options.timelineOnly,
    });
    return {
      key: segmentKey,
      ...(segment.triggerRow ? { triggerRow: segment.triggerRow } : {}),
      flowItems: prepareCuaGroupFlowItems(flowItems, {
        enabled: ENABLE_CUA_TOOL_CALL_GROUPING,
        stageTailIsRunning: segmentRunning,
      }),
      assistantWorkRows: segmentAssistantRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantHistoryDefaultOpen:
        !options.timelineOnly &&
        (options.forceOpenHistory ||
          (options.isLastTurn && segmentWorkStatus?.state === "running") ||
          (visualDrafts.length === 1 &&
            visibleAssistantTextRow === undefined &&
            segmentFlowRows.length > 0)),
      ...(segmentWorkStatus ? { workStatus: segmentWorkStatus } : {}),
    };
  });
}
/* 适配注记（P9）：接口可选属性放宽 | undefined（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。 */
