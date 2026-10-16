import { join } from "node:path";
import { executionEnvironment, prependExecutionPath } from "./environment.js";
import type { ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** 仅显式完全访问使用账户环境；不继承服务端凭据，也不提升 OS 身份。 */
export function accountEnvironment(
  request: ProcessSpawnRequest,
  home: string,
  runtimePaths?: readonly string[],
) {
  if (request.scope.sandboxMode !== "danger-full-access")
    throw new ProcessSandboxError(
      "invalid_process_request",
      "当前Task没有授予完全访问。",
    );
  const env = executionEnvironment(process.env, request.env);
  env.HOME ??= home;
  if (process.platform === "win32") {
    env.USERPROFILE ??= home;
    env.APPDATA ??= join(home, "AppData", "Roaming");
    env.LOCALAPPDATA ??= join(home, "AppData", "Local");
  }
  prependExecutionPath(env, runtimePaths);
  return env;
}

export function accountCommand(request: ProcessSpawnRequest, home: string) {
  const env = accountEnvironment(request, home);
  const argv = request.argv
    ? [request.argv.executable, ...request.argv.args]
    : request.command
      ? [request.shell ?? "/bin/sh", "-c", request.command]
      : null;
  if (!argv)
    throw new ProcessSandboxError(
      "invalid_process_request",
      "没有提供账户执行命令。",
    );
  return { argv, env };
}
