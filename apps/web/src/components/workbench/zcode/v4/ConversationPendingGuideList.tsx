/**
 * zcode 照搬：`@/v4/ConversationPendingGuideList.tsx`（references/zcode/packages/ui/src/v4/ConversationPendingGuideList.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type {
  QueueItem,
  UserInputRow,
} from "@zui/lib/zcode-shared/zcode-protocol-v4";
import { ConversationTurnRow } from "@zui/v4/ConversationTurnRow";
import type { ConversationRowRenderContext } from "@zui/v4/conversationRowContext";
import { memo, useMemo } from "react";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  const rows = useMemo(
    () => items.map((item) => pendingGuideRow(item, turnId)),
    [items, turnId],
  );
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });

  if (rows.length === 0) return null;
  return (
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 pt-5">
      {rows.map((row) => (
        <ConversationTurnRow
          key={row.sourceCommandId}
          row={row}
          context={context}
          userInputStatus={status}
        />
      ))}
    </div>
  );
}

export const ConversationPendingGuideList = memo(
  ConversationPendingGuideListImpl,
);
