"use client";

import {
  Check,
  ChevronDown,
  GitBranch,
  GitGraph as GitGraphIcon,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { GitGraphDialog } from "@/components/workbench/git-graph-dialog";
import { formatDuration } from "@/lib/usage-format";
import {
  checkoutGitBranch,
  commitGitAll,
  createGitBranch,
  fetchAgentActivity,
  fetchGitDiffStat,
  fetchGitStatus,
  initGitRepo,
  pushGit,
  type AgentActivity,
  type GitDiffStat,
  type GitStatus,
} from "@/lib/code-git-api";

/**
 * 分支 chip（Code 模式 composer 底部，紧邻工作目录 chip）。
 *
 * 数据来自服务端（`/api/code/git`，作用域 = 工作目录项目的画布）。两种「没有分支可切」
 * 的情形必须说清楚，而不是给个空下拉：
 *   - 该目录不是 git 仓库（isRepo=false）→ 显示「非 Git 仓库」；
 *   - 环境里没有 git（source=unavailable）→ 显示不可用并给出原因。
 * 切换前若工作区脏（dirty）会二次确认——避免用户以为改动丢了。
 *
 * R2-1 增强：弹层顶部提供「更改统计 / 提交 / 推送 / 创建并检出新的分支」
 * （参考图条目 1/3/5），底部提供「Git 图谱」（条目 6，按需加载）。写操作全部走服务端
 * （归属校验 + 幂等纪律在 service 层）。
 */
export function GitBranchSelect({
  accessToken,
  canvasId,
  /** 目录变了要重新取（工作目录项目的画布 id）。 */
  className,
}: {
  accessToken: string | null;
  canvasId: string | null;
  className?: string;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diffStat, setDiffStat] = useState<GitDiffStat | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  /**
   * Git 图谱（R2-1 条目 6）：**按需加载**——图谱是整段历史，没必要每次开弹层都拉；
   * `null` = 还没加载过，`lines` 为空且 `isRepo` 为真 = 仓库还没有提交。
   */
  /** 运行活动（近 7 天）：参考图 Git 弹层的「智能体 26 秒 · 4 运行」。 */
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  /** Git 图谱是**独立窗口**（参考图 `git图谱.png`）：弹层里只留入口。 */
  const [graphDialogOpen, setGraphDialogOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!accessToken || !canvasId) {
      setStatus(null);
      setDiffStat(null);
      return;
    }
    try {
      const next = await fetchGitStatus(accessToken, canvasId);
      setStatus(next);
      setNotice(null);
      // 统计只在打开时按需取（避免每敲一个文件都打接口）
      setDiffStat(
        next.isRepo && next.source !== "unavailable"
          ? await fetchGitDiffStat(accessToken, canvasId).catch(() => null)
          : null,
      );
    } catch {
      // 取不到就当没有（例如目录还没建）；不打断输入区
      setStatus(null);
      setDiffStat(null);
    }
  }, [accessToken, canvasId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * 拉运行活动（失败就当没有——不打断弹层）。
   *
   * **按工作区统计**：客户端任务 id 与服务端会话 id 不保证一致，run 挂的又是会话的
   * 载体画布而非项目画布——按会话或画布做键实测都会显示 0，故取工作区口径。
   */
  const loadActivity = useCallback(async () => {
    if (!accessToken) return;
    setActivity(await fetchAgentActivity(accessToken).catch(() => null));
  }, [accessToken]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const refresh = useCallback(async () => {
    if (!accessToken || !canvasId) return;
    const next = await fetchGitStatus(accessToken, canvasId).catch(() => null);
    if (next) setStatus(next);
    const stat = await fetchGitDiffStat(accessToken, canvasId).catch(
      () => null,
    );
    setDiffStat(stat);
  }, [accessToken, canvasId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const switchTo = useCallback(
    async (branch: string) => {
      if (!accessToken || !canvasId) return;
      if (status?.dirty) {
        const ok = window.confirm(
          `「${status.branch ?? "当前分支"}」有未提交改动，切到「${branch}」可能被拒绝或带走改动。继续？`,
        );
        if (!ok) return;
      }
      setBusy(true);
      try {
        setStatus(await checkoutGitBranch(accessToken, canvasId, branch));
        setNotice(null);
        setOpen(false);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "切换分支失败。");
      } finally {
        setBusy(false);
      }
    },
    [accessToken, canvasId, status],
  );

  const doCommit = useCallback(async () => {
    if (!accessToken || !canvasId || !commitMessage.trim()) return;
    setBusy(true);
    try {
      setStatus(await commitGitAll(accessToken, canvasId, commitMessage));
      setCommitMessage("");
      setNotice(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提交失败。");
    } finally {
      setBusy(false);
    }
  }, [accessToken, canvasId, commitMessage, refresh]);

  const doPush = useCallback(async () => {
    if (!accessToken || !canvasId) return;
    setBusy(true);
    try {
      setStatus(await pushGit(accessToken, canvasId));
      setNotice(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "推送失败。");
    } finally {
      setBusy(false);
    }
  }, [accessToken, canvasId, refresh]);

  /** 非仓库目录 → 一键初始化（初始化后自动提交就能工作）。 */
  const doInit = useCallback(async () => {
    if (!accessToken || !canvasId) return;
    setBusy(true);
    try {
      setStatus(await initGitRepo(accessToken, canvasId));
      setNotice("已初始化仓库，后续每轮对话会自动提交。");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "初始化仓库失败。");
    } finally {
      setBusy(false);
    }
  }, [accessToken, canvasId, refresh]);

  const doCreateBranch = useCallback(async () => {
    if (!accessToken || !canvasId || !newBranchName.trim()) return;
    setBusy(true);
    try {
      setStatus(
        await createGitBranch(accessToken, canvasId, newBranchName.trim()),
      );
      setNewBranchName("");
      setNotice(null);
      setOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建分支失败。");
    } finally {
      setBusy(false);
    }
  }, [accessToken, canvasId, newBranchName]);

  if (!canvasId || !status) return null;

  const label = !status.isRepo
    ? "非 Git 仓库"
    : status.source === "unavailable"
      ? "无可用 git"
      : (status.branch ?? "detached");

  const canSwitch = status.isRepo && status.source !== "unavailable";

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label="分支"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={status.source === "unavailable" || busy}
        title={
          notice ??
          (status.isRepo
            ? undefined
            : "该工作目录还不是 git 仓库（点开可一键初始化）")
        }
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[10rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
      >
        {status.isRepo ? (
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        {status.dirty ? (
          <span
            role="img"
            aria-label="有未提交改动"
            title="有未提交改动"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
        {status.source === "unavailable" ? null : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
      </button>

      {open && status.source !== "unavailable" && !status.isRepo ? (
        <div
          role="listbox"
          aria-label="分支列表"
          className="absolute top-full left-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md"
        >
          <p className="px-3 py-2 text-xs text-muted-foreground">
            该工作目录还不是 git 仓库。初始化后，每一轮对话结束都会自动提交一次，便于回滚。
          </p>
          <div className="border-t px-2 py-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void doInit();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40"
            >
              <GitBranch className="size-4" /> 初始化仓库
            </button>
          </div>
          {notice ? (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      {open && canSwitch ? (
        <div
          role="listbox"
          aria-label="分支列表"
          className="absolute top-full left-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md"
        >
          {/* 更改统计（R2-1 条目 1） */}
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {status.dirty ? "更改" : "没有未提交的更改"}
            </span>
            {diffStat && status.dirty ? (
              <span className="font-mono">
                <span className="text-emerald-600">+{diffStat.additions}</span>{" "}
                <span className="text-rose-500">−{diffStat.deletions}</span>
                <span className="ml-2 text-muted-foreground">
                  {diffStat.files} 个文件
                </span>
              </span>
            ) : null}
          </div>

          {/* 提交（R2-1 条目 3） */}
          <div className="flex items-center gap-1.5 border-t px-2 py-2">
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && commitMessage.trim() && !busy) {
                  e.preventDefault();
                  void doCommit();
                }
              }}
              placeholder={status.dirty ? "提交信息…" : "没有可提交的更改"}
              disabled={!status.dirty || busy}
              aria-label="提交信息"
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring disabled:opacity-40"
            />
            <button
              type="button"
              disabled={!status.dirty || busy || !commitMessage.trim()}
              onClick={() => void doCommit()}
              className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              提交
            </button>
          </div>

          {/* 推送（R2-1 条目 3） */}
          <div className="px-2 pb-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void doPush()}
              className="w-full rounded-md border px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
            >
              推送到上游
            </button>
          </div>

          {/* 创建并检出新的分支（R2-1 条目 5） */}
          <div className="flex items-center gap-1.5 border-t px-2 py-2">
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim() && !busy) {
                  e.preventDefault();
                  void doCreateBranch();
                }
              }}
              placeholder="创建并检出新的分支…"
              disabled={busy}
              aria-label="新分支名"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>

          {/* 运行活动（参考图：「智能体 26 秒 · 4 运行」）。口径挂 title：近 7 天。 */}
          {activity && activity.runs > 0 ? (
            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              <span
                title={`本工作区近 ${activity.windowDays} 天的 agent 运行：${activity.runs} 次、累计 ${formatDuration(
                  activity.totalSeconds,
                )}`}
              >
                智能体 {formatDuration(activity.totalSeconds)} · {activity.runs} 运行
              </span>
            </div>
          ) : null}

          {/* Git 图谱：独立窗口（参考图 git图谱.png），弹层里只留入口 */}
          <div className="border-t px-2 py-2">
            <button
              type="button"
              aria-label="Git 图谱"
              onClick={() => {
                setGraphDialogOpen(true);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <GitGraphIcon className="h-3.5 w-3.5 shrink-0" />
              Git 图谱
              <ChevronDown className="ml-auto h-3 w-3 -rotate-90" />
            </button>
          </div>

          {/* 分支列表 */}
          <div className="max-h-64 overflow-y-auto border-t p-1">
            {status.branches.map((branch) => (
              <button
                key={branch.name}
                type="button"
                role="option"
                aria-selected={branch.current}
                disabled={busy}
                onClick={() => void switchTo(branch.name)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40"
              >
                <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                {branch.current ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            ))}
          </div>

          {notice ? (
            <p className="border-t px-3 py-1.5 text-[11px] text-destructive">
              {notice}
            </p>
          ) : null}
          {status.source === "bundled" ? (
            <p className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
              使用随包 git（本机未检测到 git）
            </p>
          ) : null}
        </div>
      ) : null}
      <GitGraphDialog
        open={graphDialogOpen}
        onClose={() => setGraphDialogOpen(false)}
        accessToken={accessToken}
        canvasId={canvasId}
      />
    </div>
  );
}
