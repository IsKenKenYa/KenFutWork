import { randomUUID } from "node:crypto";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type {
  ManagedProcess,
  ProcessLimits,
  ProcessSandbox,
} from "../process-sandbox/types.js";
import type { ExecGit, GitCommandResult } from "./git-client.js";

export async function collectManagedOutput(
  process: ManagedProcess,
  maxBytes: number,
  stream?: "stdout" | "stderr",
): Promise<string> {
  let offset = 0;
  const parts: string[] = [];
  while (offset < maxBytes) {
    const page = await process.readOutput({
      offset,
      maxBytes: maxBytes - offset,
      ...(stream ? { stream } : {}),
    });
    if (page.data) parts.push(page.data);
    if (page.nextOffset <= offset) break;
    offset = page.nextOffset;
    if (page.done) break;
  }
  return parts.join("");
}

/** argv 不经用户 shell 二次解释；所有生产 git 命令由 Task 的真实沙箱持有。 */
export function createScopedGitExec(options: {
  scope: ExecutionScopeHandle;
  sandbox: ProcessSandbox;
  binary: string;
  limits: ProcessLimits;
  timeoutMs: number | null;
}): ExecGit {
  return async (args, cwd, input): Promise<GitCommandResult> => {
    const resolved = await options.scope.resolvePath(cwd, "read");
    const process = await options.sandbox.spawn({
      scope: options.scope.describe(),
      agentId: options.scope.agentId,
      invocationId: randomUUID(),
      argv: { executable: options.binary, args },
      cwd: resolved,
      background: false,
      limits: options.limits,
      timeoutMs: options.timeoutMs,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    if (input !== undefined) await process.writeStdin(input);
    await process.endStdin();
    const exit = await process.waitForExit();
    const stdout = await collectManagedOutput(
      process,
      options.limits.maxOutputBytes,
      "stdout",
    );
    const stderr = await collectManagedOutput(
      process,
      options.limits.maxOutputBytes,
      "stderr",
    );
    if (!exit.rangeEmpty)
      throw new Error("Git 命令尚未确认退出，不能报告完成。");
    if (process.snapshot().discardedBytes > 0)
      throw new Error("Git 输出超过配置上限，不能解析不完整结果。");
    return {
      code: exit.exitCode ?? 1,
      stdout,
      stderr:
        stderr ||
        (exit.exitCode !== 0 ? exit.reason || "Git 命令执行失败" : ""),
    };
  };
}
