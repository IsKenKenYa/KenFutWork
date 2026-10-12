import { useCallback, useEffect, useState } from "react";
import { FolderTreeIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import { toast } from "@zui/components/ui/toast.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 工作树管理（G4/Q10，KenFutWork 宿主件）：GitBranchSwitcher 弹层的「工作树」
 * 入口 + 管理弹窗（列表/新建/删除）。
 *
 * 数据面：GET/POST /api/code/git/worktrees、POST /api/code/git/worktrees/delete
 * （CodeGitService 的 Task 作用域缝；路径相对 Task 主目录且服务端校验不越界）。
 * 「绑为工作目录」：Task 主目录身份不可变（execution/scope-service 的
 * canonicalStoredScope 硬约束），本菜单把新建工作树的路径作为提示展示——
 * 用户可在新会话创建时选择该目录（DirectoryBrowser），不改既有 Task 身份。
 */
interface WorktreeView {
  path: string;
  head: string;
  branch: string | null;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "操作失败";
}

export function WorktreeMenu({
  workspacePath,
  workspaceIdentity,
  onDone,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 新建/删除成功后的刷新回调（重拉 git 状态）。 */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeView[] | null>(null);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  // Task id 只在打开时取（与会话切换解耦）；草稿态无 Task 时不渲染入口。
  const taskId = open
    ? useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId
    : null;

  const reload = useCallback(async () => {
    if (!taskId) return;
    try {
      const payload = await surfaceJson<{ worktrees: WorktreeView[] }>(
        `/api/code/git/worktrees?taskId=${encodeURIComponent(taskId)}`,
      );
      setWorktrees(payload.worktrees);
    } catch {
      setWorktrees([]);
    }
  }, [taskId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const create = async () => {
    if (!path.trim() || !branch.trim() || busy) return;
    if (!taskId) {
      toast("请先创建或选择 Code Task。");
      return;
    }
    setBusy(true);
    try {
      await surfaceJson("/api/code/git/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId,
          path: path.trim(),
          branch: branch.trim(),
          createBranch: true,
        }),
      });
      setPath("");
      setBranch("");
      await reload();
      onDone();
    } catch (error) {
      toast(readableError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: WorktreeView) => {
    if (busy || !taskId) return;
    setBusy(true);
    try {
      await surfaceJson("/api/code/git/worktrees/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, path: target.path }),
      });
      await reload();
      onDone();
    } catch (error) {
      toast(readableError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <FolderTreeIcon className="size-4 text-foreground-subtle" />
        工作树
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>工作树</DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <div className="space-y-3">
            <ul className="max-h-52 space-y-1 overflow-auto">
              {(worktrees ?? []).map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-ui-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">
                      {entry.branch ?? "（detached）"}
                    </span>
                    <span className="ml-2 text-foreground-subtle">
                      {entry.path}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除工作树 ${entry.branch ?? entry.path}`}
                    disabled={busy}
                    onClick={() => void remove(entry)}
                  >
                    <TrashIcon className="size-4" />
                  </Button>
                </li>
              ))}
              {worktrees !== null && worktrees.length === 0 ? (
                <li className="rounded-md border px-2.5 py-1.5 text-ui-sm text-foreground-subtle">
                  暂无工作树
                </li>
              ) : null}
            </ul>
            <div className="flex items-center gap-2">
              <Input
                aria-label="工作树目录"
                placeholder="wt-feature"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className="h-8"
              />
              <Input
                aria-label="工作树分支"
                placeholder="feature-1"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !path.trim() || !branch.trim()}
                onClick={() => void create()}
              >
                <PlusIcon className="size-4" />
                新建
              </Button>
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              新建工作树的路径可在新会话里选为工作目录
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
