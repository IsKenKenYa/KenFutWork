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
