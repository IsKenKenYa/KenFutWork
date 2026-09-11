import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ServerEnv } from "../../config/env.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { type McpClientLike, registerMcpServerTools } from "./mcp-tools.js";

/**
 * mcp-client 插件（P4d，§4.5）：连接 MCP server → 工具注册进 ctx.tools。
 * 配置：`LOOMIC_MCP_SERVERS`（JSON 数组，v1 支持 stdio 命令型 server）：
 *   [{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-fs","/tmp"]}]
 * 配置非法 fail loud；单个 server 连接失败记日志并跳过（可用性是运行态，不是配置错误）。
 */

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("[mcp] LOOMIC_MCP_SERVERS 必须是 JSON 数组（fail loud）。");
  }
  return parsed.map((entry) => {
    const config = entry as Partial<McpServerConfig>;
    if (!config.name || !config.command) {
      throw new Error(
        "[mcp] LOOMIC_MCP_SERVERS 每项需要 name 与 command（fail loud）。",
      );
    }
    return {
      name: config.name,
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  });
}

export function createMcpPlugin(): PluginDefinition {
  return {
    name: "mcp",
    inject: [],
    enabled: (env: ServerEnv) => Boolean(env.mcpServers?.length),
    apply(ctx) {
      const disposers: Array<() => void> = [];
      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose();
          } catch (error) {
            console.warn("[mcp] disconnect failed:", error);
          }
        }
      });

      // 连接是异步的：挂载后逐个连接并注册工具（可用性不影响进程启动）
      void (async () => {
        const registry = ctx.get("tools");
        for (const server of ctx.env.mcpServers ?? []) {
          try {
            const transport = new StdioClientTransport({
              command: server.command,
              ...(server.args ? { args: server.args } : {}),
              ...(server.env ? { env: server.env } : {}),
            });
            const mcpClient = new Client({
              name: "loomic-server",
              version: ctx.env.version,
            });
            await mcpClient.connect(transport);
            // 结构化收窄：SDK 类型过宽，显式适配为 McpClientLike
            const client: McpClientLike = {
              listTools: async () => {
                const result = await mcpClient.listTools();
                return { tools: result.tools };
              },
              callTool: async (args) =>
                await mcpClient.callTool({
                  name: args.name,
                  ...(args.arguments ? { arguments: args.arguments } : {}),
                }),
            };
            const { tools } = await client.listTools();
            disposers.push(
              registerMcpServerTools(registry, server.name, tools, client),
            );
            console.log(
              `[mcp] server ${server.name} connected, ${tools.length} tools registered.`,
            );
          } catch (error) {
            console.warn(
              `[mcp] server ${server.name} 连接失败，跳过其工具：`,
              error,
            );
          }
        }
      })();
    },
  };
}
