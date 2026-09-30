/**
 * zcode 照搬：`@/mentions/providers/whiteboardMentionProvider.ts`（references/zcode/packages/ui/src/mentions/providers/whiteboardMentionProvider.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { buildWhiteboardWorkspaceKey } from "@zui/lib/whiteboard";
import { filterMentionItemsWithOptions } from "@zui/mentions/mentionSearch";
import type {
  MentionCategoryResult,
  MentionItem,
} from "@zui/mentions/mentionTypes";
import { useWhiteboardStore } from "@zui/store/whiteboardStore";
import { useMemo } from "react";

function mapWhiteboardsToMentionItems(
  boards: Array<{ id: string; name: string; strokes: readonly unknown[] }>,
): MentionItem[] {
  return boards.map((board) => ({
    id: `whiteboard:${board.id}`,
    category: "whiteboards",
    label: board.name,
    description: `${board.strokes.length}`,
    value: board.id,
    markdown: `@${board.name}`,
    keywords: [board.name, board.id],
    data: {
      boardId: board.id,
      kind: "whiteboard",
    },
  }));
}

export function useWhiteboardMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const workspaceKey = buildWhiteboardWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const workspaceState = useWhiteboardStore(
    (state) => state.workspaces[workspaceKey],
  );
  const boards = useMemo(() => {
    return (
      workspaceState?.boardIds
        .map((boardId) => workspaceState.boardsById[boardId])
        .filter((board): board is NonNullable<typeof board> =>
          Boolean(board),
        ) ?? []
    );
  }, [workspaceState]);

  const items = useMemo(
    () =>
      enabled
        ? filterMentionItemsWithOptions(
            mapWhiteboardsToMentionItems(boards),
            query,
            {
              requireQuery: false,
            },
          )
        : [],
    [boards, enabled, query],
  );

  return {
    items,
    loading: false,
    error: null,
    emptyText,
    title,
  };
}
