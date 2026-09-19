"use client";

import { FolderTree, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  type CodeWorktree,
  createWorktree,
  fetchWorktrees,
  removeWorktree,
} from "@/lib/server-api";

/**
 * 工作树（R5-2「工作树」条目）。
 *
 * 一个仓库同时检出多份工作副本，各自在不同分支上——所以这里是**真的目录**：
 * - 新建：绝对路径 + 分支名（可建新分支）；路径建议是按仓库同级目录拼的 `「<仓库名>-<分支>」`；
 * - **绑为工作目录**：把这份工作树绑成当前项目的工作目录（`projects.work_dir`），
 *   之后 agent / 终端 / git 都在那份里跑——这就是「工作树」在这个产品里的用途；
 * - 删除：只删这份工作副本，**不动分支**；带未提交改动时要勾「强制删除」再来一次。
 *
 * 仓库本体（`main`）不给删除键——删它等于删仓库。
 */
export function GitWorktreeDialog({
  open,
  onClose,
  accessToken,
  canvasId,
  onBindWorkDir,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  canvasId: string | null;
  /** 把某个工作树路径绑成当前项目的工作目录；缺省时不显示该按钮。 */
  onBindWorkDir?: ((path: string) => Promise<void>) | undefined;
}) {
  const [worktrees, setWorktrees] = useState<CodeWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<{
    path: string;
    branch: string;
    create: boolean;
    force: boolean;
  }>({ path: "", branch: "", create: true, force: false });

  const repoPath = worktrees.find((tree) => tree.main)?.path ?? null;

  const refresh = useCallback(() => {
    if (!accessToken || !canvasId) return;
    setLoading(true);
    fetchWorktrees(accessToken, canvasId)
      .then((data) => setWorktrees(data.worktrees))
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : "读取工作树失败。"),
      )
      .finally(() => setLoading(false));
  }, [accessToken, canvasId]);

  useEffect(() => {
    if (open) {
      setNotice(null);
      refresh();
    }
  }, [open, refresh]);

  /** 路径建议：仓库同级目录下的「<仓库名>-<分支>」（仅当用户在路径框里还没动手时填）。 */
  const suggestedPath = (branch: string): string => {
    if (!repoPath || !branch.trim()) return "";
    const sep = repoPath.includes("\\") ? "\\" : "/";
    const parent = repoPath.slice(0, repoPath.lastIndexOf(sep));
    const name = repoPath.slice(repoPath.lastIndexOf(sep) + 1);
    return `${parent}${sep}${name}-${branch.trim().replaceAll("/", "-")}`;
  };

  const run = async (action: () => Promise<{ worktrees: CodeWorktree[] }>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setWorktrees(result.worktrees);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="border-b px-5 py-3 text-base font-medium">
          工作树
        </DialogTitle>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-xs text-muted-foreground">
            同一个仓库可以同时检出多份工作副本（各自在不同分支）。绑定为工作目录后，Agent、终端与
            Git 都在那一份里工作。
          </p>

          {!canvasId ? (
            <p className="text-sm text-muted-foreground">
              先选中一个绑定了工作目录的项目。
            </p>
          ) : (
            <>
              <ul className="divide-y rounded-lg border">
                {loading && worktrees.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-muted-foreground">
                    正在读取…
                  </li>
                ) : null}
                {worktrees.map((tree) => (
                  <li
                    key={tree.path}
                    className="flex items-start gap-2 px-3 py-2 text-sm"
                  >
                    <FolderTree className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">
                        {tree.path}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {tree.main
                          ? "仓库本体"
                          : tree.detached
                            ? "游离 HEAD（未在分支上）"
                            : `分支 ${tree.branch ?? "?"}`}
                      </span>
                    </span>
                    {!tree.main && onBindWorkDir ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            setBusy(true);
                            setNotice(null);
                            try {
                              await onBindWorkDir(tree.path);
                              setNotice(`已绑定工作目录：${tree.path}`);
                            } catch (error) {
                              setNotice(
                                error instanceof Error
                                  ? error.message
                                  : "绑定失败。",
                              );
                            } finally {
                              setBusy(false);
                            }
                          })();
                        }}
                        className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      >
                        绑为工作目录
                      </button>
                    ) : null}
                    {!tree.main ? (
                      <button
                        type="button"
                        aria-label={`删除工作树 ${tree.path}`}
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              form.force
                                ? `强制删除工作树目录（里面未提交的改动会丢）：\n${tree.path}`
                                : `删除工作树目录（分支保留）：\n${tree.path}`,
                            )
                          ) {
                            return;
                          }
                          void run(() =>
                            removeWorktree(accessToken ?? "", {
                              canvasId,
                              path: tree.path,
                              force: form.force,
                            }),
                          );
                        }}
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="mt-4 space-y-2 rounded-lg border p-3">
                <p className="text-sm">新建工作树</p>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="工作树分支名"
                    value={form.branch}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        branch: event.target.value,
                        // 路径还是上一次建议的话就跟着分支名走（用户改过就不再动）
                        path:
                          current.path === "" ||
                          current.path === suggestedPath(current.branch)
                            ? suggestedPath(event.target.value)
                            : current.path,
                      }))
                    }
                    placeholder="分支名，如 feature/x"
                    className="w-48 rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none"
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label="新建分支"
                      checked={form.create}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          create: event.target.checked,
                        }))
                      }
                    />
                    新建分支（不勾则检出已有分支）
                  </label>
                </div>
                <input
                  aria-label="工作树目录"
                  value={form.path}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      path: event.target.value,
                    }))
                  }
                  placeholder="工作树目录（绝对路径）"
                  className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none"
                />
                {!form.path && form.branch ? (
                  <button
                    type="button"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        path: suggestedPath(current.branch),
                      }))
                    }
                    className="text-[11px] text-muted-foreground underline"
                  >
                    用建议路径：
                    {suggestedPath(form.branch) || "（拿不到仓库路径）"}
                  </button>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !form.branch.trim() || !form.path.trim()}
                    onClick={() => {
                      void (async () => {
                        const ok = await run(() =>
                          createWorktree(accessToken ?? "", {
                            canvasId,
                            path: form.path.trim(),
                            branch: form.branch.trim(),
                            create: form.create,
                          }),
                        );
                        if (ok) setForm({ ...form, path: "", branch: "" });
                      })();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    创建工作树
                  </Button>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label="强制删除"
                      checked={form.force}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          force: event.target.checked,
                        }))
                      }
                    />
                    删除时丢弃未提交改动
                  </label>
                </div>
              </div>
            </>
          )}

          {notice ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
