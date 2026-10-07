import type {
  ToolDefinition,
  ToolRegistry,
  ToolScope,
} from "../../kernel/types.js";

/**
 * MCP 工具注册逻辑（P4d，纯函数可测）：
 * server 工具按 `mcp__<server>__<tool>` 命名进 ctx.tools（§4.5 命名约定）。
 * 连接由 features/mcp/plugin.ts 经官方 SDK 完成，此处只做契约映射。
 */

export interface McpServerToolLike {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface McpClientLike {
  listTools(): Promise<{ tools: McpServerToolLike[] }>;
  callTool(
    args: {
      name: string;
      arguments?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export function toKernelTool(
  serverName: string,
  tool: McpServerToolLike,
  client: McpClientLike,
): ToolDefinition {
  return createMcpToolDefinition(
    serverName,
    tool,
    "design",
    async (args, context) =>
      client.callTool({ name: tool.name, arguments: args }, context.signal),
  );
}

/** MCP配置参数的公共事件投影；重复投影保留envKeys，不修改真实执行参数。 */
export function projectMcpArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args.env || typeof args.env !== "object" || Array.isArray(args.env))
    return { ...args };
  const output: Record<string, unknown> = {
    ...args,
    envKeys: Object.keys(args.env),
  };
  delete output.env;
  return output;
}

export function createMcpToolDefinition(
  serverName: string,
  tool: McpServerToolLike,
  scope: ToolScope,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name}`,
    scope,
    exposure: "deferred",
    // 外部readOnlyHint不是本机权限证明；未知效果按执行策略做人审。
    access: "execute",
    projectArguments: projectMcpArguments,
    parameters: tool.inputSchema ?? { type: "object" },
    execute,
  };
}

/**
 * 把一个 MCP server 的工具清单注册进统一工具注册表。
 * 返回注销 disposer（断连时撤销全部工具）；重名工具 fail loud（由注册表保证）。
 */
export function registerMcpServerTools(
  registry: ToolRegistry,
  serverName: string,
  tools: McpServerToolLike[],
  client: McpClientLike,
): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (const tool of tools)
      disposers.push(registry.register(toKernelTool(serverName, tool, client)));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
  };
}
