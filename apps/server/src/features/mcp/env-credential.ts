/**
 * MCP 配置凭据的只读查询缝（宿主内部使用，不经 HTTP 暴露）。
 *
 * 背景：jev 判决插件本身不带凭据——TypeSafe 的 key 存在「MCP 服务器条目」的 env
 * （精选目录 `TYPESAFE_API_KEY`）里。知识库需要同一把 key 注入 `sag config`，
 * 但 MCP 服务的公开面（`listStatuses`）只下发键名，明文只在
 * `readSettingsConfigurations()`（注释写明「仅供已授权本机设置编辑器」）。
 *
 * 这条缝只做一件事：按「服务器名 + 环境变量名」取一个值，**不枚举、不返回整个
 * env**，也不进入日志、事件或 run 快照（`DEC-7`）。
 */

export const MCP_ENV_CREDENTIAL_CAPABILITY = "mcp-env-credential";

export interface McpEnvCredentialReader {
  /** 按 MCP 服务器名 + 环境变量名读取凭据；不存在或被停用时返回 null。 */
  readEnvValue(serverName: string, envKey: string): Promise<string | null>;
}

/** 读取任意一台已启用 MCP 服务器上指定 env 键的第一个非空值（按名称精确匹配）。 */
export function createMcpEnvCredentialReader(deps: {
  readConfigurations: () => Promise<
    Array<{
      name: string;
      enabled: boolean;
      env: Record<string, string>;
    }>
  >;
}): McpEnvCredentialReader {
  return {
    async readEnvValue(serverName, envKey) {
      const configurations = await deps.readConfigurations();
      const server = configurations.find(
        (item) => item.name === serverName && item.enabled,
      );
      const value = server?.env[envKey]?.trim();
      return value ? value : null;
    },
  };
}
