import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ServerEnv } from "../../config/env.js";
import type { ToolExecutionContext, ToolRegistry } from "../../kernel/types.js";
import type { ComputerUseMcpConnection } from "../computer-use/mcp-backend.js";
import { type McpClientLike, registerMcpServerTools } from "./mcp-tools.js";
import type {
  McpServerCreateRaw,
  McpServerPatch,
  McpServerStore,
  PublicMcpServer,
} from "./server-store.js";
import { mcpFailure } from "./task-mcp-context.js";

/**
 * MCP server 运行态管理（连接生命周期 + 配置变更后的收敛）。
 *
 * 此前 MCP 配置只能来自 `KENFUTWORK_MCP_SERVERS` 环境变量，连接在启动时一次性完成，
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
  kind: "stdio" | "http";
  command: string;
  args: string[];
  /** http 类型的远程端点 URL（stdio 为 null）。 */
  url: string | null;
  envKeys: string[];
  toolCount: number;
  /** 上次连接失败原因（status=error 时有值）。 */
  error: string | null;
}

export interface McpService {
  /** 仅供已授权本机设置编辑器；普通目录仍使用listStatuses。 */
  readSettingsConfigurations(): Promise<McpSettingsConfiguration[]>;
  computerUseConnections(): Promise<ComputerUseMcpConnection[]>;
  listStatuses(): Promise<McpServerStatus[]>;
  /** 启动期连接：环境变量 + 库内启用项。 */
  connectAll(): Promise<void>;
  create(input: McpServerCreateRaw): Promise<PublicMcpServer>;
  update(id: string, patch: McpServerPatch): Promise<PublicMcpServer | null>;
  setEnabled(id: string, enabled: boolean): Promise<PublicMcpServer | null>;
  remove(id: string): Promise<number>;
  /** 手动重连（配置未变但连接掉线时用）；`idOrName` 允许环境变量条目按名称传入。 */
  reconnect(idOrName: string): Promise<McpServerStatus | null>;
  shutdown(): Promise<void>;
}

export interface McpSettingsConfiguration {
  id: string | null;
  name: string;
  source: "env" | "managed";
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  args: string[];
  url: string | null;
  env: Record<string, string>;
}

interface Connection {
  client: Client;
  disposeTools: () => void;
  toolCount: number;
  call: McpClientLike["callTool"];
}

export function createMcpService(options: {
  env: ServerEnv;
  registry: ToolRegistry;
  store: McpServerStore;
  resolveTimeoutMs?: () => Promise<number>;
}): McpService {
  /** name → 已连接（含工具注销器）。 */
  const connections = new Map<string, Connection>();
  /** name → 上次失败原因（连接成功时清除）。 */
  const failures = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  const initializing = new Set<Client>();
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("MCP服务已关闭，禁止迟到连接或配置变更。");
  };
  const requestOptions = async (signal?: AbortSignal) => {
    const timeout =
      (await options.resolveTimeoutMs?.()) ??
      AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs;
    return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) };
  };

  function envServers() {
    return options.env.mcpServers ?? [];
  }

  async function connect(
    name: string,
    spec: { kind: "stdio" | "http"; command: string; url: string | null; args: string[]; env: Record<string, string> },
  ) {
    ensureOpen();
    await disconnect(name);
    const mcpClient = new Client({
      name: "kenfutwork-server",
      version: options.env.version,
    });
    let closedDuringConnect = false;
    mcpClient.onclose = () => {
      closedDuringConnect = true;
      const connection = connections.get(name);
      if (connection?.client !== mcpClient) return;
      connections.delete(name);
      connection.disposeTools();
      if (!closed) failures.set(name, "MCP连接已断开，请在库存中重连。");
    };
    initializing.add(mcpClient);
    try {
      if (spec.kind === "http" && spec.url) {
        const url = new URL(spec.url);
        try {
          await mcpClient.connect(new StreamableHTTPClientTransport(url) as Parameters<Client["connect"]>[0], await requestOptions());
        } catch (streamableError) {
          ensureOpen();
          try {
            closedDuringConnect = false;
            await mcpClient.connect(new SSEClientTransport(url), await requestOptions());
          } catch {
            throw streamableError;
          }
        }
      } else {
        await mcpClient.connect(new StdioClientTransport({
          command: spec.command, args: spec.args, env: spec.env,
        }), await requestOptions());
      }
      const client: McpClientLike = {
        listTools: async () => {
          const result = await mcpClient.listTools(
            undefined,
            await requestOptions(),
          );
          return { tools: result.tools };
        },
        callTool: async (callArgs, signal) =>
          await mcpClient.callTool(
            {
              name: callArgs.name,
              ...(callArgs.arguments ? { arguments: callArgs.arguments } : {}),
            },
            undefined,
            await requestOptions(signal),
          ),
      };
      const { tools } = await client.listTools();
      ensureOpen();
      if (closedDuringConnect) throw new Error("MCP握手期间连接已经关闭。");
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
        call: client.callTool,
      });
      failures.delete(name);
      console.log(
        `[mcp] server ${name} connected, ${tools.length} tools registered.`,
      );
    } catch (error) {
      await mcpClient.close().catch(() => {});
      const message = mcpFailure(error, spec.env, "mcp_connect_failed").message;
      failures.set(name, message);
      console.warn(`[mcp] server ${name} 连接失败，跳过其工具：${message}`);
    } finally {
      initializing.delete(mcpClient);
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
    kind: "stdio" | "http";
    command: string;
    url: string | null;
    args: string[];
    env: Record<string, string>;
    enabled: boolean;
  }) {
    ensureOpen();
    const prior = pending.get(server.name) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        ensureOpen();
        const current = (await effectiveServers()).find(
          (candidate) => candidate.name === server.name,
        );
        if (!current?.enabled) {
          await disconnect(server.name);
          return;
        }
        await connect(current.name, current);
      });
    const tracked = next.finally(() => {
      if (pending.get(server.name) === tracked) pending.delete(server.name);
    });
    pending.set(server.name, tracked);
    await tracked;
  }

  async function toStatus(server: {
    id: string | null;
    name: string;
    source: "env" | "managed";
    enabled: boolean;
    kind: "stdio" | "http";
    command: string;
    url: string | null;
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
        kind: "stdio" as const,
        command: server.command,
        url: null,
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
    async readSettingsConfigurations() {
      ensureOpen();
      return (await effectiveServers()).map((server) => ({
        id: server.id,
        name: server.name,
        source: server.source,
        enabled: server.enabled,
        kind: server.kind,
        command: server.command,
        args: [...server.args],
        url: server.url,
        env: { ...server.env },
      }));
    },
    async computerUseConnections() {
      const statuses = await this.listStatuses();
      return [...connections].flatMap(([name, connection]) => {
        const capability = connection.client.getServerCapabilities()
          ?.experimental?.["kenfutwork.computer-use"] as
          | { version?: number }
          | undefined;
        if (capability?.version !== 1) return [];
        const status = statuses.find((row) => row.name === name);
        return [
          {
            id: status?.id ?? `env:${name}`,
            name,
            call: async (
              tool: string,
              args: Record<string, unknown>,
              context: ToolExecutionContext,
            ) => {
              ensureOpen();
              context.signal?.throwIfAborted();
              if (connections.get(name) !== connection)
                throw new Error("所选桌面MCP连接已断开或被替换，请重新选择");
              return connection.call(
                { name: tool, arguments: args },
                context.signal,
              );
            },
          },
        ];
      });
    },
    async listStatuses() {
      const servers = await effectiveServers();
      return Promise.all(
        servers.map((server) =>
          toStatus({
            id: server.id,
            name: server.name,
            source: server.source,
            enabled: server.enabled,
            kind: server.kind,
            command: server.command,
            url: server.url,
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

    async create(rawInput) {
      ensureOpen();
      const kind = rawInput.kind ?? "stdio";
      const input = {
        ...rawInput, kind,
        command: kind === "http" ? "" : (rawInput.command ?? ""),
        url: kind === "http" ? (rawInput.url ?? null) : null,
      };
      const created = await options.store.create(input);
      await reconcile(created);
      // 回读公开形态（env 值不下发）
      const { env: _env, ...rest } = created;
      return { ...rest, envKeys: Object.keys(created.env) };
    },

    async update(id, patch) {
      ensureOpen();
      const updated = await options.store.update(id, patch);
      if (!updated) {
        return null;
      }
      await reconcile(updated);
      const { env: _env, ...rest } = updated;
      return { ...rest, envKeys: Object.keys(updated.env) };
    },

    async setEnabled(id, enabled) {
      ensureOpen();
      const updated = await options.store.setEnabled(id, enabled);
      if (!updated) {
        return null;
      }
      await reconcile(updated);
      const { env: _env, ...rest } = updated;
      return { ...rest, envKeys: Object.keys(updated.env) };
    },

    async remove(id) {
      ensureOpen();
      const stored = (await options.store.list()).find(
        (server) => server.id === id,
      );
      const removed = await options.store.remove(id);
      if (stored) await reconcile({ ...stored, enabled: false });
      return removed;
    },

    async reconnect(idOrName) {
      ensureOpen();
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
              kind: "stdio" as const,
              command: envFallback.command,
              url: null,
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
      closed = true;
      await Promise.allSettled(
        [...initializing].map((client) => client.close()),
      );
      await Promise.allSettled([...pending.values()]);
      for (const name of [...connections.keys()]) {
        await disconnect(name);
      }
    },
  };
}
