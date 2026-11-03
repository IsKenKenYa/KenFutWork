import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import type {
  RunTimelineEntry,
  RunTimelineResponse,
  TaskRunsResponse,
} from "@kenfutwork/shared";
import { parseLocalWorkspaceIdentity } from "@zcode/shared";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

/**
 * 运行记录回看（宿主件）：先按 Task 列出历史轮次，点选某一轮再进入单轮时间线。
 *
 * 数据面：GET /api/agent/tasks/:taskId/runs 与 GET /api/agent/runs/:runId/timeline
 * （服务端两条缝都已存在）。入口挂在检查点对话框与状态面板，没有检查点也能用。
 * 读取失败、空列表与超出单页上限都给可读说明，不摆空壳。
 */
const RUN_STATUS_LABEL: Record<
  TaskRunsResponse["runs"][number]["status"],
  string
> = {
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

/** 列表每次多取 20 轮；服务端单页上限 50，到顶后如实说明只显示最近 50 轮。 */
const RUNS_PAGE_STEP = 20;
const RUNS_MAX_LIMIT = 50;

type RunSummary = TaskRunsResponse["runs"][number];

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

function formatStarted(iso: string): string {
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

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;
}

function spanDurationMs(
  startedAt: string,
  completedAt: string | null,
): number | null {
  if (!completedAt) return null;
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(completed)) return null;
  return Math.max(0, completed - started);
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "读取失败";
}

function usageLabel(run: RunSummary): string {
  return run.usage
    ? `输入 ${run.usage.inputTokens} 输出 ${run.usage.outputTokens}`
    : "用量 未统计";
}

export function RunTimelineDialog({
  taskId,
  projectId,
  initialRunId,
  open,
  onOpenChange,
}: {
  taskId: string;
  /** 服务端按项目核对 Task 归属；缺失时如实说明，不发请求。 */
  projectId: string | null;
  /** 从检查点进入时标出对应轮次，仍先展示轮次列表。 */
  initialRunId?: string | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsFailure, setRunsFailure] = useState<string | null>(null);
  const [limit, setLimit] = useState(RUNS_PAGE_STEP);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<RunTimelineResponse | null>(null);
  const [timelineFailure, setTimelineFailure] = useState<string | null>(
    null,
  );

  const loadRuns = useCallback(async () => {
    if (!projectId) {
      setRuns(null);
      setRunsFailure("缺少项目信息");
      return;
    }
    setRuns(null);
    setRunsFailure(null);
    try {
      const result = await surfaceJson<TaskRunsResponse>(
        `/api/agent/tasks/${encodeURIComponent(taskId)}/runs?projectId=${encodeURIComponent(projectId)}&limit=${limit}`,
      );
      setRuns(result.runs);
    } catch (error) {
      setRunsFailure(readableError(error));
    }
  }, [limit, projectId, taskId]);

  const loadRun = useCallback(async (runId: string) => {
    setPayload(null);
    setTimelineFailure(null);
    try {
      setPayload(
        await surfaceJson<RunTimelineResponse>(
          `/api/agent/runs/${encodeURIComponent(runId)}/timeline`,
        ),
      );
    } catch (error) {
      setTimelineFailure(readableError(error));
    }
  }, []);

  // 关闭后回到轮次列表与首页大小，下次打开不会停在上次翻到的位置。
  useEffect(() => {
    if (open) return;
    setSelectedRunId(null);
    setPayload(null);
    setTimelineFailure(null);
    setLimit(RUNS_PAGE_STEP);
  }, [open]);

  useEffect(() => {
    if (!open || selectedRunId !== null) return;
    void loadRuns();
  }, [loadRuns, open, selectedRunId]);

  useEffect(() => {
    if (!open || selectedRunId === null) return;
    void loadRun(selectedRunId);
  }, [loadRun, open, selectedRunId]);

  const run = payload?.run;
  const duration = run ? spanDurationMs(run.startedAt, run.completedAt) : null;
  const canShowMore = runs !== null && runs.length >= limit && limit < RUNS_MAX_LIMIT;
  const reachedLimit = runs !== null && runs.length >= RUNS_MAX_LIMIT;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{selectedRunId === null ? "运行轮次" : "运行记录"}</DialogTitle>
          <DialogDescription />
        </DialogHeader>
        {selectedRunId === null ? (
          <div className="space-y-3">
            {runsFailure ? (
              <p className="text-ui-sm text-foreground-subtle">{runsFailure}</p>
            ) : runs === null ? (
              <p className="text-ui-sm text-foreground-subtle">读取轮次…</p>
            ) : runs.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                这个 Task 还没有运行记录
              </p>
            ) : (
              <>
                <ul className="max-h-72 space-y-1 overflow-auto text-ui-sm">
                  {runs.map((row) => {
                    const rowDuration = spanDurationMs(
                      row.startedAt,
                      row.completedAt,
                    );
                    return (
                      <li key={row.runId}>
                        <button
                          type="button"
                          data-testid={`run-row-${row.runId}`}
                          className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-border px-2 py-1 text-left hover:bg-[var(--color-hover)]"
                          onClick={() => setSelectedRunId(row.runId)}
                        >
                          <span className="shrink-0">
                            {formatStarted(row.startedAt)}
                          </span>
                          <span className="shrink-0 text-foreground-subtle">
                            {RUN_STATUS_LABEL[row.status]}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {row.model ?? "模型 未记录"}
                          </span>
                          {rowDuration === null ? null : (
                            <span className="shrink-0 text-foreground-subtle">
                              耗时 {formatDuration(rowDuration)}
                            </span>
                          )}
                          <span className="shrink-0 text-foreground-subtle">
                            {usageLabel(row)}
                          </span>
                          {row.usage?.costUsd == null ? null : (
                            <span className="shrink-0 text-foreground-subtle">
                              花费 ${row.usage.costUsd.toFixed(4)}
                            </span>
                          )}
                          {initialRunId === row.runId ? (
                            <span className="shrink-0 text-foreground-subtle">
                              当前检查点
                            </span>
                          ) : null}
                          {row.errorMessage ? (
                            <span className="w-full truncate text-foreground-subtle">
                              {row.errorMessage}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {canShowMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setLimit((current) =>
                        Math.min(current + RUNS_PAGE_STEP, RUNS_MAX_LIMIT),
                      )
                    }
                  >
                    查看更多
                  </Button>
                ) : null}
                {reachedLimit ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    只显示最近 50 轮
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {timelineFailure ? (
              <p className="text-ui-sm text-foreground-subtle">{timelineFailure}</p>
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
        )}
        <DialogFooter>
          {selectedRunId === null ? (
            <>
              {runsFailure ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadRuns()}
                >
                  重新读取
                </Button>
              ) : null}
              <Button type="button" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSelectedRunId(null)}
              >
                轮次列表
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadRun(selectedRunId)}
              >
                重新读取
              </Button>
              <Button
                type="button"
                onClick={() => {
                  window.open(
                    `${getSurfaceApiBase()}/api/agent/runs/${encodeURIComponent(selectedRunId)}/timeline/export`,
                    "_blank",
                    "noopener",
                  );
                }}
              >
                导出记录
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 状态面板里的运行记录入口：有 Task 就有，不依赖检查点。 */
export function RunHistoryEntry({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const [open, setOpen] = useState(false);
  const taskId = useZCodeSessionStore
    .getState()
    .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;
  const projectId =
    parseLocalWorkspaceIdentity(workspaceIdentity ?? "", workspacePath)
      ?.projectId ?? null;
  if (!taskId) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        aria-label="运行记录"
        data-testid="run-history-trigger"
        onClick={() => setOpen(true)}
      >
        <HistoryIcon className="size-3.5" />
        运行记录
      </Button>
      <RunTimelineDialog
        taskId={taskId}
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
