import type { IFileService } from "@zcode/services";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { fetchWorkspaceFileEntriesPacked } from "@zui/workspace-file-search/fetchWorkspaceFileEntries.js";
import { useCallback, useEffect, useMemo, useState } from "react";

type FileRead =
  | { status: "idle" | "loading" }
  | { status: "ready"; entries: WorkspaceFileEntry[] }
  | { status: "error"; cause: unknown };

export function useCommandCenterFileIndex({
  enabled,
  fileService,
  workspacePath,
  workspaceKey,
  activeTaskId,
}: {
  enabled: boolean;
  fileService: IFileService;
  workspacePath: string;
  workspaceKey: string;
  activeTaskId: string | null | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((current) => current + 1), []);
  // 保留同次搜索的索引；退出、换任务或重试时新建读取。
  const scope = useMemo(
    () =>
      enabled
        ? { fileService, workspacePath, workspaceKey, activeTaskId, attempt }
        : null,
    [enabled, fileService, workspacePath, workspaceKey, activeTaskId, attempt],
  );
  const [settled, setSettled] = useState<{
    scope: NonNullable<typeof scope>;
    read: FileRead;
  } | null>(null);
  useEffect(() => {
    if (!scope) {
      setSettled(null);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    void fetchWorkspaceFileEntriesPacked(
      scope.fileService,
      scope.workspacePath,
      signal,
    )
      .then((packed) => {
        if (signal.aborted) return;
        const entries = unpackWorkspaceFileEntries(packed, scope.workspacePath);
        setSettled({ scope, read: { status: "ready", entries } });
      })
      .catch((cause: unknown) => {
        if (!signal.aborted)
          setSettled({ scope, read: { status: "error", cause } });
      });
    return () => controller.abort();
  }, [scope]);

  const read: FileRead =
    scope && settled?.scope === scope
      ? settled.read
      : { status: scope ? "loading" : "idle" };
  return { read, refresh };
}
