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
        args: ["--no-optional-locks", ...args],
      },
      cwd,
      background: false,
      limits: options.limits,
      timeoutMs: options.timeoutMs,
      env: {
        GIT_DIR: directory.gitDir,
        GIT_WORK_TREE: cwd,
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
