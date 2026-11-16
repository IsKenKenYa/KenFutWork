import {
  ApiAccessError,
  ApiApplicationError,
  type CheckpointSummary,
  checkpointListResponseSchema,
  checkpointPreviewResponseSchema,
  checkpointRestoreResponseSchema,
} from "@kenfutwork/shared";
import { parseLocalWorkspaceIdentity } from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RunTimelineDialog } from "./RunTimelineDialog.js";
import { surfaceJson } from "./surfaceApi.js";

type RestorePreview = ReturnType<typeof checkpointPreviewResponseSchema.parse>;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function optionLabel(row: CheckpointSummary): string {
  return `${formatTimestamp(row.createdAt)} · ${row.filesChanged} 个文件 +${row.insertions} −${row.deletions}`;
}

function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiApplicationError)) return fallback;
  if (error.status === 401) return new ApiAccessError().message;
  if (error.code === "application_error" && (error.status ?? 0) >= 500)
    return fallback;
  return error.message;
}

type ReadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

function useCheckpointRead<T>(
  path: string | null,
  read: (path: string, signal: AbortSignal) => Promise<T>,
  fallback: string,
) {
  const [result, setResult] = useState<{
    path: string;
    attempt: number;
    state: Exclude<ReadState<T>, { status: "loading" }>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const { signal } = controller;
    void read(path, signal).then(
      (value) => {
        if (!signal.aborted)
          setResult({ path, attempt, state: { status: "ready", value } });
      },
      (failure: unknown) => {
        if (!signal.aborted)
          setResult({
            path,
            attempt,
            state: {
              status: "error",
              message: readableError(failure, fallback),
            },
          });
      },
    );
    return () => controller.abort();
  }, [path, attempt, read, fallback]);
  const state: ReadState<T> =
    path && result?.path === path && result.attempt === attempt
      ? result.state
      : { status: "loading" };
  return { state, reload };
}

async function readCheckpoints(path: string, signal: AbortSignal) {
  const result = checkpointListResponseSchema.parse(
    await surfaceJson<unknown>(path, { signal }),
  );
  return result.checkpoints.reverse();
}

async function readPreview(path: string, signal: AbortSignal) {
  return checkpointPreviewResponseSchema.parse(
    await surfaceJson<unknown>(path, { method: "POST", signal }),
  );
}

export function CheckpointTimeline({
  workspacePath,
  workspaceIdentity,
  onRestored,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onRestored?: () => void;
}) {
  const taskId = useZCodeSessionStore(
    (state) =>
      state.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId,
  );
  if (!taskId) return null;
  const projectId =
    parseLocalWorkspaceIdentity(workspaceIdentity ?? "", workspacePath)
      ?.projectId ?? null;
  return (
    <TaskCheckpointTimeline
      key={taskId}
      taskId={taskId}
      projectId={projectId}
      onRestored={onRestored}
    />
  );
}

function TaskCheckpointTimeline({
  taskId,
  projectId,
  onRestored,
}: {
  taskId: string;
  projectId: string | null;
  onRestored?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const query = `taskId=${encodeURIComponent(taskId)}`;
  const list = useCheckpointRead(
    `/api/code/checkpoints?${query}`,
    readCheckpoints,
    "无法读取检查点 请重试",
  );
  const checkpoints = list.state.status === "ready" ? list.state.value : [];
  const selectedCheckpoint = checkpoints.find((row) => row.id === selectedId);
  const selectedPath = selectedCheckpoint
    ? `/api/code/checkpoints/${encodeURIComponent(selectedCheckpoint.id)}`
    : null;
  const previewRead = useCheckpointRead(
    open && selectedPath ? `${selectedPath}/preview?${query}` : null,
    readPreview,
    "无法读取回滚预览 请重试",
  );
  const preview =
    previewRead.state.status === "ready" && !restoreError
      ? previewRead.state.value
      : null;

  function close() {
    setOpen(false);
    setSelectedId(null);
    setRestoreError(null);
    previewRead.reload();
  }

  function retryPreview() {
    setRestoreError(null);
    previewRead.reload();
  }

  async function restore() {
    if (!open || !selectedPath || !preview || busy) return;
    setBusy(true);
    try {
      checkpointRestoreResponseSchema.parse(
        await surfaceJson<unknown>(`${selectedPath}/restore?${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: preview.expectedVersion }),
        }),
      );
    } catch (error) {
      setRestoreError(readableError(error, "无法回滚 请检查工作目录"));
      return;
    } finally {
      setBusy(false);
    }
    close();
    list.reload();
    onRestored?.();
  }

  if (list.state.status === "error")
    return (
      <CheckpointReadError
        message={list.state.message}
        label="重试读取检查点"
        retry={list.reload}
      />
    );
  if (checkpoints.length === 0) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        aria-label="检查点"
        data-testid="checkpoint-timeline-trigger"
        onClick={() => {
          setSelectedId((current) => current ?? checkpoints[0]?.id ?? null);
          setOpen(true);
        }}
      >
        <HistoryIcon className="size-3.5" />
        检查点
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) close();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>回滚到检查点</DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <div className="space-y-3">
            <Select
              value={selectedId ?? ""}
              disabled={busy}
              onValueChange={(next) => {
                if (typeof next !== "string" || next === selectedId) return;
                setSelectedId(next);
                retryPreview();
              }}
            >
              <SelectTrigger aria-label="回滚目标" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {checkpoints.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {optionLabel(row)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CheckpointPreviewContent
              state={previewRead.state}
              restoreError={restoreError}
              retry={retryPreview}
            />
            <p className="text-ui-sm text-foreground-subtle">
              丢弃所选时点后的未提交改动
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTimelineOpen(true)}
              disabled={!selectedCheckpoint?.runId || busy}
            >
              这一轮运行
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || preview === null}
              onClick={() => void restore()}
            >
              {busy ? "回滚中…" : "回滚"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RunTimelineDialog
        taskId={taskId}
        projectId={projectId}
        initialRunId={selectedCheckpoint?.runId ?? null}
        open={timelineOpen && Boolean(selectedCheckpoint?.runId)}
        onOpenChange={setTimelineOpen}
      />
    </>
  );
}

function CheckpointReadError({
  message,
  label,
  retry,
}: {
  message: string;
  label: string;
  retry(): void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 p-2">
      <p role="alert" className="min-w-0 flex-1 text-ui-sm text-destructive">
        {message}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={retry}>
        {label}
      </Button>
    </div>
  );
}

function CheckpointPreviewContent({
  state,
  restoreError,
  retry,
}: {
  state: ReadState<RestorePreview>;
  restoreError: string | null;
  retry(): void;
}) {
  const error =
    restoreError ?? (state.status === "error" ? state.message : null);
  if (error)
    return (
      <CheckpointReadError message={error} label="重新预览" retry={retry} />
    );
  if (state.status !== "ready")
    return (
      <p role="status" className="text-ui-sm text-foreground-subtle">
        读取预览…
      </p>
    );
  const preview = state.value;
  return (
    <div className="rounded-md border border-border p-2.5 text-ui-sm text-foreground-subtle">
      <p>
        将覆盖 {preview.filesChanged} 个文件的未提交改动（+{preview.insertions}{" "}
        −{preview.deletions}）
      </p>
      <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto">
        {preview.files.map((file) => (
          <li
            key={JSON.stringify([file.rootDirectory, file.path])}
            className="truncate"
            title={file.rootDirectory}
          >
            {file.path}（
            {file.added === null || file.deleted === null
              ? "二进制文件"
              : `+${file.added} −${file.deleted}`}
            ）
          </li>
        ))}
      </ul>
    </div>
  );
}
