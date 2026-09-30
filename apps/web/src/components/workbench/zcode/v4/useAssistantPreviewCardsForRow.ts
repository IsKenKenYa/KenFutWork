/**
 * zcode 照搬：`@/v4/useAssistantPreviewCardsForRow.ts`（references/zcode/packages/ui/src/v4/useAssistantPreviewCardsForRow.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import {
  type AssistantPreviewCard,
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
} from "@zui/lib/assistantPreviewCards";
import type {
  AssistantTextRow,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zui/lib/zcode-shared/zcode-protocol-v4";
import { logger } from "@zui/logger";
import type {
  ConversationFileChangesRequestOptions,
  ConversationFileChangesState,
} from "@zui/v4/conversationRowContext";
import { useEffect, useMemo, useState } from "react";

interface UseAssistantPreviewCardsForAssistantTextRowParams {
  row?: AssistantTextRow | undefined;
  assistantTextRows: readonly AssistantTextRow[];
  latestAssistantTextRow?: AssistantTextRow | undefined;
  workspacePath: string;
  workspaceHomePath?: string | undefined;
  fileChangesTarget: ConversationRowTarget | null;
  fileChangesState?: ConversationFileChangesState | undefined;
  fetchFileChanges?:
    | ((
        target: ConversationRowTarget,
        options: ConversationFileChangesRequestOptions,
      ) => Promise<V4ConversationFileChangesResult>)
    | undefined;
}

interface LoadedChangedPaths {
  key: string;
  paths: readonly string[];
}

const EMPTY_CHANGED_FILE_PATHS: readonly string[] = [];

function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {
  return rows
    .map((row) => row.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function useAssistantPreviewCardsForAssistantTextRow({
  row,
  assistantTextRows,
  latestAssistantTextRow,
  workspacePath,
  workspaceHomePath,
  fileChangesTarget,
  fileChangesState,
  fetchFileChanges,
}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCard[] {
  const turnText = useMemo(
    () => joinAssistantTurnText(assistantTextRows),
    [assistantTextRows],
  );
  const canBuildCards =
    row !== undefined &&
    latestAssistantTextRow?.rowId === row.rowId &&
    (row.state === "complete" || row.state === "interrupted");
  const fileReferences = useMemo(
    () =>
      canBuildCards
        ? extractAssistantFileReferences(turnText, workspacePath, {
            homePath: workspaceHomePath,
          })
        : [],
    [canBuildCards, turnText, workspaceHomePath, workspacePath],
  );
  const needsFileChanges = fileReferences.some(
    (reference) => reference.kind === "markdown" || reference.kind === "html",
  );
  const target = useMemo<ConversationRowTarget | null>(
    () =>
      fileChangesTarget
        ? {
            rowId: fileChangesTarget.rowId,
            entityId: fileChangesTarget.entityId,
          }
        : null,
    [fileChangesTarget?.entityId, fileChangesTarget?.rowId],
  );
  const requestKey = target
    ? `${target.rowId}:${target.entityId}:${fileChangesState ?? "unknown"}`
    : "";
  const [loadedChangedPaths, setLoadedChangedPaths] =
    useState<LoadedChangedPaths | null>(null);

  useEffect(() => {
    if (!needsFileChanges || !fetchFileChanges || !target) return;
    // rewind 后 header 的 reverted 状态是权威投影；无需等待详情 RPC，立即抑制 md/html。
    if (fileChangesState === "reverted") return;

    let disposed = false;
    // V4 fileChanges 只接受 turnHeader；assistantText 仅用于正文和卡片锚点。
    // 先用空门控同步投影 Office/PDF；只有确实出现 md/html 时才读取本轮明细。
    void fetchFileChanges(target, {
      cachePolicy: "terminal",
      fileChangesState,
    }).then(
      (result) => {
        if (disposed) return;
        setLoadedChangedPaths({
          key: requestKey,
          paths:
            result.state === "reverted"
              ? []
              : result.items.map((item) => item.path),
        });
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn(
          "[AssistantPreviewCards] 读取本轮文件变更失败，已抑制 Markdown/HTML 卡片",
          {
            error: error instanceof Error ? error.message : String(error),
            rowId: target.rowId,
          },
        );
        setLoadedChangedPaths({ key: requestKey, paths: [] });
      },
    );

    return () => {
      disposed = true;
    };
  }, [
    fetchFileChanges,
    fileChangesState,
    needsFileChanges,
    requestKey,
    target,
  ]);

  const changedFilePaths =
    needsFileChanges && loadedChangedPaths?.key === requestKey
      ? loadedChangedPaths.paths
      : EMPTY_CHANGED_FILE_PATHS;

  return useMemo(
    () =>
      canBuildCards
        ? buildAssistantPreviewCardsFromReferences(
            turnText,
            workspacePath,
            fileReferences,
            {
              changedFilePaths,
              homePath: workspaceHomePath,
            },
          )
        : [],
    [
      canBuildCards,
      changedFilePaths,
      fileReferences,
      turnText,
      workspaceHomePath,
      workspacePath,
    ],
  );
}
