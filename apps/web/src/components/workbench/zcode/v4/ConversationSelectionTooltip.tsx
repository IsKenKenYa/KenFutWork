/**
 * zcode 照搬：`@/v4/ConversationSelectionTooltip.tsx`（references/zcode/packages/ui/src/v4/ConversationSelectionTooltip.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import { useTextSelection } from "@zui/hooks/useTextSelection";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  guardConversationSelectionCandidate,
  hasExcludedConversationSelectionEndpoint,
} from "@zui/lib/conversationSelectionGuard";
import {
  type ConversationSelectionContentType,
  type ConversationSelectionReference,
  createConversationSelectionReference,
} from "@zui/lib/conversationSelectionReference";
import type { ConversationRow } from "@zui/lib/zcode-shared/zcode-protocol-v4";
import { SelectionActionMenu } from "@zui/v4/SelectionActionMenu";
import { type RefObject, useCallback, useRef } from "react";

interface TooltipState {
  center: number;
  bottom: number;
  top: number;
  reference?: ConversationSelectionReference | undefined;
  error?: "single" | undefined;
}

const SELECTABLE_SELECTOR = "[data-conversation-selectable]";

function contentTypeForRow(
  row: ConversationRow,
): ConversationSelectionContentType | null {
  if (row.kind === "userInput") return "user";
  if (row.kind === "assistantText") return "assistant";
  if (row.kind === "reasoning") return "reasoning";
  if (row.kind === "toolCall") return "tool";
  return null;
}

function closestRowElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-row-id]") ?? null;
}

export function ConversationSelectionTooltip({
  rootRef,
  rows,
  sourceSessionId,
  enabled,
  sideActionDisabled,
  onAddToCurrentTask,
  onAskInSideChat,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: readonly ConversationRow[];
  sourceSessionId: string;
  enabled: boolean;
  sideActionDisabled?: boolean | undefined;
  onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
  onAskInSideChat: (reference: ConversationSelectionReference) => void;
}) {
  const { intl } = useZCodeIntl();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const inspectSelection = useCallback((): TooltipState | null => {
    if (!enabled) return null;
    const root = rootRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount !== 1
    ) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const startRow = closestRowElement(range.startContainer);
    const endRow = closestRowElement(range.endContainer);
    if (!startRow || !endRow) return null;
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    // 普通 Markdown 跨选到表格单元格时，Range.cloneContents() 会把 DOM 顺序中夹着的
    // select-none 表格工具栏按钮一并克隆，若据此判断会把合法正文误判为控件选区。控件门禁只看
    // Selection 两个端点；跨 row / selectable region 仍由下面的独立 guard 拒绝。
    const excluded = hasExcludedConversationSelectionEndpoint(
      startElement,
      endElement,
    );
    const startContent = startElement?.closest(SELECTABLE_SELECTOR);
    const endContent = endElement?.closest(SELECTABLE_SELECTOR);
    const rowId = Number(startRow.dataset.rowId);
    const row = rowsRef.current.find((candidate) => candidate.rowId === rowId);
    const contentType = row ? contentTypeForRow(row) : null;
    const text = selection.toString().trim();
    const rect = range.getBoundingClientRect();
    const guardResult = guardConversationSelectionCandidate({
      enabled,
      sameRow: startRow === endRow,
      insideTimeline: root.contains(startRow),
      excluded,
      sameSelectableRegion: Boolean(
        startContent &&
          startContent === endContent &&
          startRow.contains(startContent),
      ),
      supportedContent: contentType !== null,
      text,
      hasLayout: rect.width > 0 || rect.height > 0,
    });
    if (guardResult === "ineligible" || !contentType) return null;
    const position = {
      center: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (guardResult === "single-limit") {
      return { ...position, error: "single" };
    }
    return {
      ...position,
      reference: createConversationSelectionReference({
        sourceSessionId,
        sourceRowId: rowId,
        contentType,
        text,
      }),
    };
  }, [enabled, rootRef, sourceSessionId]);
  const { state, close } = useTextSelection({
    rootRef,
    enabled,
    inspect: inspectSelection,
    scopeKey: sourceSessionId,
  });

  if (!state) return null;
  return (
    <SelectionActionMenu
      center={state.center}
      top={state.top}
      bottom={state.bottom}
      singleLimit={Boolean(state.error)}
      sideActionDisabled={sideActionDisabled}
      sideDisabledTitle={intl.formatMessage({
        id: "chat.selections.sideBlocked",
      })}
      onAddToCurrentTask={() => {
        if (state.reference) onAddToCurrentTask(state.reference);
        close();
      }}
      onAskInSideChat={() => {
        if (state.reference) onAskInSideChat(state.reference);
        close();
      }}
    />
  );
}
