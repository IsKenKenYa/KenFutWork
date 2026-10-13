import { prependRuntimePath } from "../../desktop/runtimes.js";

/** 操作系统与显式安装的运行时入口，服务端数据库/provider 配置一律不继承。 */
const EXECUTION_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

export function executionEnvironment(
  ambient: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of EXECUTION_ENV_KEYS) {
    const value = ambient[key];
    if (value !== undefined) output[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error("执行环境包含无效的变量名或内容。");
    }
    // Node 的 IPC/loader 注入通道不是用户执行环境。
    if (
      key.startsWith("NODE_CHANNEL_") ||
      key === "NODE_OPTIONS" ||
      key === "NODE_EXTRA_CA_CERTS"
    )
      continue;
    output[key] = value;
  }
  return output;
}

/**
 * 把随包运行时的 bin 目录前置进沙箱执行环境的 PATH。
 *
 * 为什么必须显式做：`executionEnvironment` 只从宿主 `process.env.PATH` 取 PATH，
 * 而随包运行时（`<resourceRoot>/runtime/{node,python,uv,jdk/bin}`）**不在宿主 PATH 上**——
 * 启动期 `runtimePathAdditions` 只喂给了 deepagents 后端，进程沙箱拿不到。
 * 结果就是沙箱里 `python` 按名字找不到（原《未做需求》#12，已收口：智能体能写 Python 却跑不了、
 * Python MCP 服务器也注册不了）。这里把 bin 目录补进沙箱 PATH，与 readRoots 成对使用：
 * **PATH 决定找得到，readRoots 决定跑得起来**，缺一不可。
 */
export function prependExecutionPath(
  env: Record<string, string>,
  additions: readonly string[] | undefined,
): void {
  if (!additions?.length) return;
  const separator = process.platform === "win32" ? ";" : ":";
  env.PATH = prependRuntimePath(env.PATH, additions, separator);
}
