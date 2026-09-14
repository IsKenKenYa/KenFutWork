import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ServerEnv } from "../../config/env.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { type McpClientLike, registerMcpServerTools } from "./mcp-tools.js";
import type {
  McpServerPatch,
  McpServerStore,
  McpServerUpsertInput,
  PublicMcpServer,
} from "./server-store.js";

/**
 * MCP server 运行态管理（连接生命周期 + 配置变更后的收敛）。
 *
 * 此前 MCP 配置只能来自 `LOOMIC_MCP_SERVERS` 环境变量，连接在启动时一次性完成，
 * 界面上既不能增删也不能重连。本服务把「连接」变成可增删改的运行态：
 *
 * - 来源两种：`env`（环境变量，只读，UI 标注来源）与 `managed`（库内配置，可增删改）；
 *   同名时库内配置优先（环境变量作为引导/遗留入口）。
 * - 配置变更后**收敛**：启用 → 连接（重连会先断开旧连接并注销其工具）；停用/删除 → 断开。
 * - 连接失败是**运行态**而非配置错误：记 `status=error` 与原因，工具不注册，不阻断进程。
 * - env 值只用于起进程，绝不经 HTTP 下发（只下发键名）。
 */

export type McpServerStatusState = "connected" | "error" | "disabled";

export interface McpServerStatus {
  id: string | null;
  name: string;
  source: "env" | "managed";
  enabled: boolean;
  status: McpServerStatusState;
  command: string;
  args: string[];
  envKeys: string[];
  toolCount: number;
  /** 上次连接失败原因（status=error 时有值）。 */
  error: string | null;
}

export interface McpService {
  listStatuses(): Promise<McpServerStatus[]>;
  /** 启动期连接：环境变量 + 库内启用项。 */
  connectAll(): Promise<void>;
  create(input: McpServerUpsertInput): Promise<PublicMcpServer>;
  update(id: string, patch: McpServerPatch): Promise<PublicMcpServer | null>;
  setEnabled(id: string, enabled: boolean): Promise<PublicMcpServer | null>;
  remove(id: string): Promise<number>;
  /** 手动重连（配置未变但连接掉线时用）；`idOrName` 允许环境变量条目按名称传入。 */
  reconnect(idOrName: string): Promise<McpServerStatus | null>;
  shutdown(): Promise<void>;
}

interface Connection {
  client: Client;
  disposeTools: () => void;
  toolCount: number;
}

export function createMcpService(options: {
  env: ServerEnv;
  registry: ToolRegistry;
  store: McpServerStore;
}): McpService {
  /** name → 已连接（含工具注销器）。 */
  const connections = new Map<string, Connection>();
  /** name → 上次失败原因（连接成功时清除）。 */
  const failures = new Map<string, string>();

  function envServers() {
    return options.env.mcpServers ?? [];
  }

  async function connect(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
  ) {
    await disconnect(name);
    try {
      const transport = new StdioClientTransport({
        command,
        args,
        env,
      });
      const mcpClient = new Client({
        name: "loomic-server",
        version: options.env.version,
      });
      await mcpClient.connect(transport);
      const client: McpClientLike = {
        listTools: async () => {
          const result = await mcpClient.listTools();
          return { tools: result.tools };
        },
        callTool: async (callArgs) =>
          await mcpClient.callTool({
            name: callArgs.name,
            ...(callArgs.arguments ? { arguments: callArgs.arguments } : {}),
          }),
      };
      const { tools } = await client.listTools();
      const disposeTools = registerMcpServerTools(
        options.registry,
        name,
        tools,
        client,
      );
      connections.set(name, {
        client: mcpClient,
        disposeTools,
        toolCount: tools.length,
      });
      failures.delete(name);
      console.log(
        `[mcp] server ${name} connected, ${tools.length} tools registered.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(name, message);
      console.warn(`[mcp] server ${name} 连接失败，跳过其工具：${message}`);
    }
  }

  async function disconnect(name: string) {
    const connection = connections.get(name);
    if (!connection) {
      return;
    }
    connections.delete(name);
    try {
      connection.disposeTools();
    } catch (error) {
      console.warn(`[mcp] ${name} 工具注销失败：`, error);
    }
    try {
      await connection.client.close();
    } catch (error) {
      console.warn(`[mcp] ${name} 连接关闭失败：`, error);
    }
  }

  async function reconcile(server: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: boolean;
  }) {
    if (!server.enabled) {
      await disconnect(server.name);
      return;
    }
    await connect(server.name, server.command, server.args, server.env);
  }

  async function toStatus(server: {
    id: string | null;
    name: string;
    source: "env" | "managed";
    enabled: boolean;
    command: string;
    args: string[];
    envKeys: string[];
  }): Promise<McpServerStatus> {
    const connection = connections.get(server.name);
    const failure = failures.get(server.name);
    const status: McpServerStatusState = !server.enabled
      ? "disabled"
      : connection
        ? "connected"
        : "error";
    return {
      ...server,
      status,
      toolCount: connection?.toolCount ?? 0,
      error: server.enabled && !connection ? (failure ?? null) : null,
    };
  }

  /** 合并来源：库内（managed）优先，环境变量补充未重名的项。 */
  async function effectiveServers() {
    const managed = await options.store.list();
    const managedNames = new Set(managed.map((server) => server.name));
    const fromEnv = envServers()
      .filter((server) => !managedNames.has(server.name))
      .map((server) => ({
        id: null,
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        enabled: true,
        source: "env" as const,
      }));
    return [
      ...managed.map((server) => ({ ...server, source: "managed" as const })),
      ...fromEnv,
    ];
  }

  return {
    async listStatuses() {
      const servers = await effectiveServers();
      return Promise.all(
        servers.map((server) =>
          toStatus({
            id: server.id,
            name: server.name,
            source: server.source,
            enabled: server.enabled,
            command: server.command,
            args: server.args,
            envKeys: Object.keys(server.env),
          }),
        ),
      );
    },

    async connectAll() {
      /**
       * 启动期连接**绝不允许**把进程带走：这里读库（表缺失/数据库不可用都会抛）
       * 与起子进程（命令不存在、握手失败）都可能失败，而调用方是 fire-and-forget
       * （`void service.connectAll()`）——未捕获的拒绝会变成 unhandled rejection
       * 直接终止进程（实测踩中：迁移尚未落地时服务反复崩溃、所有端点不可用）。
       */
      try {
        const servers = await effectiveServers();
        for (const server of servers) {
          try {
            await reconcile(server);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            failures.set(server.name, message);
            console.warn(
              `[mcp] server ${server.name} 启动连接失败（不影响进程）：${message}`,
            );
          }
        }
      } catch (error) {
        console.warn(
          "[mcp] 启动连接跳过（配置读取失败，可在界面重连）：",
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async create(input) {
      const created = await options.store.create(input);
      await reconcile(created);
      // 回读公开形态（env 值不下发）
      const { env: _env, ...rest } = created;
      return { ...rest, envKeys: Object.keys(created.env) };
    },

    async update(id, patch) {
      const updated = await options.store.update(id, patch);
      if (!updated) {
        return null;
      }
      await reconcile(updated);
      const { env: _env, ...rest } = updated;
      return { ...rest, envKeys: Object.keys(updated.env) };
    },

    async setEnabled(id, enabled) {
      const updated = await options.store.setEnabled(id, enabled);
      if (!updated) {
        return null;
      }
      await reconcile(updated);
      const { env: _env, ...rest } = updated;
      return { ...rest, envKeys: Object.keys(updated.env) };
    },

    async remove(id) {
      const stored = (await options.store.list()).find(
        (server) => server.id === id,
      );
      if (stored) {
        await disconnect(stored.name);
      }
      return options.store.remove(id);
    },

    async reconnect(idOrName) {
      // 库内条目按 id 定位；环境变量条目没有 id（只读），允许按名称重连
      const statuses = await this.listStatuses();
      const target =
        statuses.find((status) => status.id === idOrName) ??
        statuses.find(
          (status) => status.source === "env" && status.name === idOrName,
        );
      if (!target) {
        return null;
      }
      const managed = (await options.store.list()).find(
        (server) => server.id === target.id,
      );
      const envFallback = envServers().find(
        (server) => server.name === target.name,
      );
      const config =
        managed ??
        (envFallback
          ? {
              name: envFallback.name,
              command: envFallback.command,
              args: envFallback.args ?? [],
              env: envFallback.env ?? {},
              enabled: true,
            }
          : null);
      if (!config) {
        return null;
      }
      await reconcile(config);
      const refreshed = (await this.listStatuses()).find(
        (status) =>
          status.id === target.id &&
          (target.id !== null || status.name === target.name),
      );
      return refreshed ?? null;
    },

    async shutdown() {
      for (const name of [...connections.keys()]) {
        await disconnect(name);
      }
    },
  };
}
