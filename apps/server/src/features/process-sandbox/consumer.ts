import type { CodeExecutionScope } from "@kenfutwork/shared";
import type { ManagedProcess, ProcessLimits, ProcessSandbox } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** 只消费 scope 公共 interface；不反向依赖 scope Provider 或维护 Task 登记。 */
interface ScopeConsumer {
  describe(): CodeExecutionScope;
  resolvePath(path: string, operation: "read" | "write"): Promise<string>;
}

export function createScopedExecute(
  processSandbox: ProcessSandbox,
  scopeHandle: ScopeConsumer,
  context: {
    agentId: string;
    invocationId: string;
    limits: ProcessLimits;
    signal?: AbortSignal;
  },
): (input: {
  command: string;
  cwd?: string;
  shell?: string;
  background: boolean;
  timeoutMs?: number | null;
  env?: Readonly<Record<string, string>>;
}) => Promise<ManagedProcess> {
  return async (input) => {
    context.signal?.throwIfAborted();
    const cwd = await scopeHandle.resolvePath(input.cwd ?? ".", "read");
    const scope = scopeHandle.describe();
    const child = await processSandbox.spawn({
      scope,
      agentId: context.agentId,
      invocationId: context.invocationId,
      command: input.command,
      cwd,
      background: input.background,
      limits: context.limits,
      ...(input.shell ? { shell: input.shell } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.env ? { env: input.env } : {}),
    });
    if (!input.background && context.signal) {
      const signal = context.signal;
      const stop = (): void => {
        void child.stop("foreground_cancelled").catch(() => {});
      };
      signal.addEventListener("abort", stop, { once: true });
      void child
        .waitForExit()
        .finally(() => signal.removeEventListener("abort", stop))
        .catch(() => {});
      if (signal.aborted) {
        const exit = await child.stop("foreground_cancelled");
        if (!exit.rangeEmpty)
          throw new ProcessSandboxError(
            "stop_unconfirmed",
            "前台命令取消后尚未确认退出。",
          );
        signal.throwIfAborted();
      }
    }
    return child;
  };
}
