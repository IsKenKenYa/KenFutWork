import { Button } from "@zui/components/ui/button.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { useCallback, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * GitPane 非仓库空态的「初始化仓库」动作（宿主适配件）。
 *
 * vendored GitPane 只挂这个入口；真实 git init 走服务端 code-git 缝
 * （POST /api/code/git/init，Task 作用域目录），成功后经 onRefresh 重拉面板状态，
 * 失败把服务端给的可读原因显示在按钮下方。
 */
export function GitPaneInitRepositoryAction({
  workspacePath,
  workspaceIdentity,
  onRefresh,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (busy) return;
    const taskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;
    if (!taskId) {
      setError("请先创建或选择 Code Task。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await surfaceJson("/api/code/git/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "初始化仓库失败。");
    } finally {
      setBusy(false);
    }
  }, [busy, onRefresh, workspaceIdentity, workspacePath]);

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <Button
        type="button"
        size="lg"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
      >
        初始化仓库
      </Button>
      {error ? (
        <p className="max-w-full text-ui-base text-foreground-subtle">
          {error}
        </p>
      ) : null}
    </div>
  );
}
