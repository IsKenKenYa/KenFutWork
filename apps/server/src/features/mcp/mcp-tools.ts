import type { ToolDefinition, ToolRegistry } from "../../kernel/types.js";

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
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

export function toKernelTool(
  serverName: string,
  tool: McpServerToolLike,
  client: McpClientLike,
): ToolDefinition {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name}`,
    scope: "shared",
    parameters: tool.inputSchema ?? { type: "object" },
    execute: async (args) =>
      client.callTool({ name: tool.name, arguments: args }),
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
  const disposers = tools.map((tool) =>
    registry.register(toKernelTool(serverName, tool, client)),
  );
  return () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
  };
}
