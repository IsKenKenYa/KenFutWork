import { executionEnvironment } from "./environment.js";
import type { ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** SRT Unix wrapper 需要命令字符串；每个 argv token 独立引用，不添加 eval/二次展开。 */
export function unixCommand(request: ProcessSpawnRequest): string {
  const target = request.argv
    ? [request.argv.executable, ...request.argv.args]
    : request.command
      ? [request.shell ?? "/bin/sh", "-c", request.command]
      : null;
  if (!target)
    throw new ProcessSandboxError(
      "invalid_process_request",
      "没有提供命令或 argv。",
    );
  const explicit = executionEnvironment({}, request.env);
  // LD_PRELOAD/BASH_ENV 等显式执行变量只能在 OS sandbox 内的 env 进程应用。
  // 不能放到宿主 launcher 的 spawn env，否则会先于 confinement 执行用户代码。
  return [
    "/usr/bin/env",
    "--",
    ...Object.entries(explicit).map(([key, value]) => `${key}=${value}`),
    ...target,
  ]
    .map(quote)
    .join(" ");
}
