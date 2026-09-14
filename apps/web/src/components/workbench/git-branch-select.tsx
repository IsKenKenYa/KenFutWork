"use client";

import { Check, ChevronDown, GitBranch, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkoutGitBranch,
  fetchGitStatus,
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!accessToken || !canvasId) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await fetchGitStatus(accessToken, canvasId));
      setNotice(null);
    } catch {
      // 取不到就当没有（例如目录还没建）；不打断输入区
      setStatus(null);
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
        disabled={!canSwitch || busy}
        title={
          notice ??
          (status.isRepo
            ? undefined
            : "该工作目录还不是 git 仓库（在对话里让 Agent 执行 git init 即可）")
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
            aria-label="有未提交改动"
            title="有未提交改动"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
        {canSwitch ? <ChevronDown className="h-3 w-3 shrink-0" /> : null}
      </button>

      {open && canSwitch ? (
        <div
          role="listbox"
          aria-label="分支列表"
          className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md"
        >
          <div className="max-h-64 overflow-y-auto p-1">
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
          {status.source === "bundled" ? (
            <p className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
              使用随包 git（本机未检测到 git）
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
