import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import type { RunTimelineEntry, RunTimelineResponse } from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

/**
 * 一轮运行的记录回看（宿主件）：把服务端时间线投影成一眼能读的列表，
 * 含状态、用量与失败原文，并提供 Markdown 导出入口。
 *
 * 数据面：GET /api/agent/runs/:runId/timeline 与 /timeline/export（服务端缝健在）。
 * 入口挂在检查点对话框里，用该检查点对应的 runId 打开；读取失败显示可读原因。
 */
const RUN_STATUS_LABEL: Record<RunTimelineResponse["run"]["status"], string> = {
  accepted: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const ENTRY_STATUS_LABEL: Record<
  NonNullable<RunTimelineEntry["status"]>,
  string
> = {
  success: "成功",
  error: "失败",
  cancelled: "已取消",
  running: "进行中",
};

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;
}

function runDurationMs(run: RunTimelineResponse["run"]): number | null {
  if (!run.completedAt) return null;
  const started = new Date(run.startedAt).getTime();
  const completed = new Date(run.completedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(completed)) return null;
  return Math.max(0, completed - started);
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "读取失败";
}

export function RunTimelineDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [payload, setPayload] = useState<RunTimelineResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPayload(null);
    setFailure(null);
    try {
      setPayload(
        await surfaceJson<RunTimelineResponse>(
          `/api/agent/runs/${encodeURIComponent(runId)}/timeline`,
        ),
      );
    } catch (error) {
      setFailure(readableError(error));
    }
  }, [runId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const run = payload?.run;
  const duration = run ? runDurationMs(run) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>运行记录</DialogTitle>
          <DialogDescription />
        </DialogHeader>
        <div className="space-y-3">
          {failure ? (
            <p className="text-ui-sm text-foreground-subtle">{failure}</p>
          ) : payload === null || run === undefined ? (
            <p className="text-ui-sm text-foreground-subtle">读取记录…</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui-sm">
                <span>状态 {RUN_STATUS_LABEL[run.status]}</span>
                <span>模型 {run.model ?? "未记录"}</span>
                {duration === null ? null : (
                  <span>耗时 {formatDuration(duration)}</span>
                )}
                {run.usage ? (
                  <span>
                    输入 {run.usage.inputTokens} 输出 {run.usage.outputTokens}
                  </span>
                ) : (
                  <span>用量 未统计</span>
                )}
                {run.usage?.costUsd == null ? null : (
                  <span>花费 ${run.usage.costUsd.toFixed(4)}</span>
                )}
              </div>
              {run.errorMessage ? (
                <p className="text-ui-sm text-foreground-subtle">
                  {run.errorMessage}
                </p>
              ) : null}
              <ul className="max-h-64 space-y-1 overflow-auto text-ui-sm">
                {payload.entries.length === 0 ? (
                  <li className="text-foreground-subtle">这一轮没有记录</li>
                ) : (
                  payload.entries.map((entry) => (
                    <li
                      key={entry.seq}
                      className="flex items-baseline gap-2 rounded-md border border-border px-2 py-1"
                    >
                      <span className="shrink-0 text-foreground-subtle">
                        {formatClock(entry.at)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {entry.title}
                        {entry.agentName ? ` · ${entry.agentName}` : ""}
                      </span>
                      {entry.durationMs === undefined ? null : (
                        <span className="shrink-0 text-foreground-subtle">
                          {formatDuration(entry.durationMs)}
                        </span>
                      )}
                      {entry.status === undefined ? null : (
                        <span className="shrink-0 text-foreground-subtle">
                          {ENTRY_STATUS_LABEL[entry.status]}
                        </span>
                      )}
                    </li>
                  ))
                )}
              </ul>
              {payload.entries.length === 0 ? null : (
                <p className="text-ui-sm text-foreground-subtle">
                  事件按发生顺序排列
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void load()}>
            重新读取
          </Button>
          <Button
            type="button"
            onClick={() => {
              window.open(
                `${getSurfaceApiBase()}/api/agent/runs/${encodeURIComponent(runId)}/timeline/export`,
                "_blank",
                "noopener",
              );
            }}
          >
            导出记录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
