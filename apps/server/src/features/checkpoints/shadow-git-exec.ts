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
        // 影子仓库是 GIT_DIR 指向的独立仓库，工作树在 GIT_DIR 之外，必须显式声明：
        // `-c core.worktree=<cwd>` 与 `--work-tree=<cwd>` 双通道给出，避免任何一侧被
        // 执行层吃掉时 Git 找不到工作树。
        args: [
          "--no-optional-locks",
          "-c",
          `core.worktree=${cwd}`,
          `--work-tree=${cwd}`,
          ...args,
        ],
      },
      cwd,
      background: false,
      limits: options.limits,
      timeoutMs: options.timeoutMs,
      // GIT_DIR 是影子仓库唯一入口；不发 GIT_WORK_TREE——它一旦非空会压过仓库 config 的
      // core.worktree（`ensureRepo` 写的就是这个键），工作树改由 argv 显式声明。
      env: {
        GIT_DIR: directory.gitDir,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (input !== undefined) await child.writeStdin(input);
    await child.endStdin();
    const exit = await child.waitForExit();
    if (!exit.rangeEmpty) throw new Error("检查点 Git 尚未确认退出。");
    // preserveNul：影子 Git 用 `ls-files -z` 清单与 `--pathspec-file-nul` 传路径，
    // NUL 是唯一不可能出现在路径里的分隔符；默认的 NUL 剥离会把整份清单粘成一个路径
    // （真机实测 `pathspec ... did not match any files`）。这里的输出只服务端内部解析。
    const stdout = await collectManagedOutput(
      child,
      options.limits.maxOutputBytes,
      "stdout",
      true,
    );
    const stderr = await collectManagedOutput(
      child,
      options.limits.maxOutputBytes,
      "stderr",
      true,
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
