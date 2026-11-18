import {
  resolveTerminalShell,
  type runTerminalCommand,
  shellInvocation,
} from "../code-git/terminal-runner.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type {
  ProcessLimits,
  ProcessSandbox,
} from "../process-sandbox/types.js";

/** 用户钩子与 Bash 使用同一个执行器、目录授权和实际停止证据。 */
export function createScopedHookCommand(options: {
  sandbox: ProcessSandbox;
  scope: ExecutionScopeHandle;
  runId: string;
  event: string;
  limits: ProcessLimits;
  signal?: AbortSignal;
}): typeof runTerminalCommand {
  let ordinal = 0;
  return async (input) => {
    options.signal?.throwIfAborted();
    const cwd = await options.scope.resolvePath(input.cwd, "read");
    const shell = resolveTerminalShell(input.shell, input.availableShells);
    if (!shell) throw new Error("找不到可用的 shell，未执行用户钩子。");
    const startedAt = Date.now();
    const process = await options.sandbox.spawn({
      scope: options.scope.describe(),
      agentId: options.scope.agentId,
      invocationId: `${options.runId}/hook/${options.event}/${ordinal++}`,
      argv: shellInvocation(shell, input.command),
      cwd,
      background: false,
      limits: options.limits,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    const stop = () => {
      void process
        .stop("用户取消前台钩子")
        .catch((error: unknown) =>
          console.error("[hooks] 钩子停止未确认：", error),
        );
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      if (options.signal?.aborted) await process.stop("用户取消前台钩子");
      const exit = await process.waitForExit();
      const [stdout, stderr] = await Promise.all([
        process.readOutput({
          offset: 0,
          maxBytes: options.limits.maxOutputBytes,
          stream: "stdout",
        }),
        process.readOutput({
          offset: 0,
          maxBytes: options.limits.maxOutputBytes,
          stream: "stderr",
        }),
      ]);
      return {
        command: input.command,
        shell: shell.id,
        exitCode: exit.exitCode,
        timedOut: exit.reason === "deadline_exceeded",
        stdout: stdout.data,
        stderr: stderr.data,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  };
}
