import { randomUUID } from "node:crypto";
import { collectManagedOutput } from "../code-git/scoped-git-exec.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type {
  ProcessLimits,
  ProcessSandbox,
} from "../process-sandbox/types.js";
import type { ExecShadowGit } from "./shadow-git-client.js";

/** 系统消费者可写精确 Task 私有元数据目录；用户目录权限仍来自同一个 Scope。 */
export function createShadowGitExec(options: {
  scope: ExecutionScopeHandle;
  sandbox: ProcessSandbox;
  binary: string;
  limits: ProcessLimits;
  timeoutMs: number | null;
}): ExecShadowGit {
  return async (args, directory, input) => {
    const cwd = await options.scope.resolvePath(directory.workTree, "read");
    const child = await options.sandbox.spawnCheckpoint({
      scope: options.scope.describe(),
      agentId: options.scope.agentId,
      invocationId: randomUUID(),
      argv: {
        executable: options.binary,
        // `--work-tree` 显式给工作树：沙箱只把请求 env 里的 GIT_DIR 送到了 git，
        // GIT_WORK_TREE 没到（实测 `git add` 报「this operation must be run in a work tree」），
        // 而影子仓库是 GIT_DIR 指向的独立仓库、cwd 不在其中，必须显式声明工作树。
        args: ["--no-optional-locks", `--work-tree=${cwd}`, ...args],
      },
      cwd,
      background: false,
      limits: options.limits,
      timeoutMs: options.timeoutMs,
      /**
       * 只发 GIT_DIR，**不发 GIT_WORK_TREE**：沙箱（Windows broker）把请求 env/argv 吃掉了一部分，
       * 发过去的 `GIT_WORK_TREE` 与 argv `--work-tree` 都到不了 git（实测仍报
       * `fatal: this operation must be run in a work tree`），而 GIT_WORK_TREE 一旦被设成非空值又会
       * **压过**仓库 config 的 `core.worktree`。工作树改由 `ensureRepo` 写进影子仓库本地 config
       * （`core.worktree`，宿主与随包 git 都实测有效），这条通道不依赖 env/argv 传递。
       */
      env: {
        GIT_DIR: directory.gitDir,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (input !== undefined) await child.writeStdin(input);
    await child.endStdin();
    const exit = await child.waitForExit();
    if (!exit.rangeEmpty) throw new Error("检查点 Git 尚未确认退出。");
    const stdout = await collectManagedOutput(
      child,
      options.limits.maxOutputBytes,
      "stdout",
    );
    const stderr = await collectManagedOutput(
      child,
      options.limits.maxOutputBytes,
      "stderr",
    );
    if (child.snapshot().discardedBytes > 0)
      throw new Error("检查点 Git 输出超限，不能使用不完整结果。");
    return {
      code: exit.exitCode ?? 1,
      stdout,
      stderr:
        stderr ||
        (exit.exitCode !== 0 ? exit.reason || "检查点 Git 执行失败" : ""),
    };
  };
}
