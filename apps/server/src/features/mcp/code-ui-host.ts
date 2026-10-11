import {
  codeUiMcpSettingsLoadRequestSchema,
  codeUiMcpSettingsReadRequestSchema,
  codeUiMcpSettingsSaveRequestSchema,
  codeUiMcpStatusRequestSchema,
  type LoadCliMcpFromUserDirectoryResult,
  mcpServerCreateRequestSchema,
  zcodeMcpListResultSchema,
} from "@kenfutwork/shared";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { McpService } from "./mcp-service.js";

/** 只适配原接口；同一McpService同时供HTTP、运行工具及原设置页使用。 */
export function createCodeUiMcpHost(deps: {
  service: McpService;
  localInstance: LocalInstanceService;
}): Record<string, CodeUiHostRpcHandler> {
  const notFound = () =>
    new CodeUiHostRpcError(
      "mcp_server_not_found",
      "MCP配置已删除，请刷新列表。",
      404,
    );
  const unsupported = (message: string) =>
    new CodeUiHostRpcError("mcp_capability_unavailable", message, 501);
  return {
    "mcp-sync.readMcpServerConfiguration": {
      async call(actor, args) {
        await deps.localInstance.resolve(actor);
        const input = codeUiMcpSettingsReadRequestSchema.parse(args[0]);
        const row = (await deps.service.readSettingsConfigurations()).find(
          (row) => row.id === input.hostRecordId,
        );
        if (!row) throw notFound();
        return {
          source: "zcodeagentmcp",
          scope: "user",
          name: row.name,
          enabled: row.enabled,
          origin: row.source,
          hostRecordId: row.id,
          config:
            row.kind === "http"
              ? { type: "http", url: row.url, headers: row.headers }
              : { command: row.command, args: row.args, env: row.env },
        };
      },
    },
    "mcp-sync.saveMcpToUserDirectory": {
      async call(actor, args) {
        await deps.localInstance.resolve(actor);
        const input = codeUiMcpSettingsSaveRequestSchema.parse(args[0]);
        if (input.projectPath || input.location)
          throw unsupported("项目MCP配置未接入，请使用本机配置。");
        const existing = input.hostRecordId
          ? (await deps.service.readSettingsConfigurations()).find(
              (row) => row.id === input.hostRecordId && row.name === input.name,
            )
          : null;
        if (input.hostRecordId && !existing) throw notFound();
        if (input.action === "delete") {
          if (
            !input.hostRecordId ||
            !(await deps.service.remove(input.hostRecordId))
          )
            throw notFound();
          return null;
        }
        if (input.action === "set-enabled") {
          if (input.enabled === undefined)
            throw new CodeUiHostRpcError(
              "invalid_mcp_request",
              "缺少MCP启用状态。",
              400,
            );
          if (
            !input.hostRecordId ||
            !(await deps.service.setEnabled(input.hostRecordId, input.enabled))
          )
            throw notFound();
          return null;
        }
        const config = input.config;
        if (!config)
          throw new CodeUiHostRpcError(
            "invalid_mcp_request",
            "缺少MCP配置。",
            400,
          );
        if (
          config.oauth !== undefined ||
          config.timeoutMs !== undefined ||
          (config.protocolVersion && config.protocolVersion !== "auto")
        )
          throw unsupported("MCP授权和服务参数未接入。");
        const normalized = mcpServerCreateRequestSchema.parse({
          name: input.name,
          kind: config.type === "http" || config.url ? "http" : "stdio",
          command: config.command,
          url: config.url,
          args: config.args ?? [],
          env: config.env ?? existing?.env ?? {},
          headers:
            config.type === "http" || config.url
              ? (config.headers ?? existing?.headers ?? {})
              : {},
          enabled: config.enable ?? existing?.enabled ?? true,
        });
        if (input.hostRecordId) {
          const updated = await deps.service.update(input.hostRecordId, {
            ...normalized,
            command: normalized.kind === "http" ? "" : normalized.command,
            url: normalized.kind === "http" ? normalized.url : null,
          });
          if (!updated) throw notFound();
        } else {
          try {
            await deps.service.create(normalized);
          } catch (error) {
            if (
              error instanceof Error &&
              /duplicate|unique/i.test(error.message)
            )
              throw new CodeUiHostRpcError(
                "mcp_server_exists",
                "同名MCP配置已存在，请刷新列表。",
                409,
              );
            throw error;
          }
        }
        return null;
      },
    },
    "mcp-sync.loadMcpFromUserDirectory": {
      async call(actor, args): Promise<LoadCliMcpFromUserDirectoryResult> {
        await deps.localInstance.resolve(actor);
        codeUiMcpSettingsLoadRequestSchema.parse(args[0] ?? {});
        const rows = await deps.service.readSettingsConfigurations();
        return {
          servers: rows.map((row) => ({
            source: "zcodeagentmcp",
            scope: "user",
            name: row.name,
            enabled: row.enabled,
            origin: row.source,
            envKeys: Object.keys(row.env),
            ...(row.id ? { hostRecordId: row.id } : {}),
            config:
              row.kind === "http"
                ? { type: "http", url: row.url ?? "" }
                : { command: row.command, args: row.args },
          })),
        };
      },
    },
    "mcp-sync.listWorkspaceMcpServerStatuses": {
      async call(actor, args) {
        await deps.localInstance.resolve(actor);
        const input = codeUiMcpStatusRequestSchema.parse(args[0] ?? {});
        // UI配置只用于选择现有名字，不能将任意command/env作为运行配置。
        const names = input.mcpServers?.map((server) => server.name);
        let rows = await deps.service.listStatuses();
        if (input.mode === "connect") {
          for (const row of rows) {
            if (row.enabled && (!names || names.includes(row.name)))
              await deps.service.reconnect(row.id ?? row.name);
          }
          rows = await deps.service.listStatuses();
        }
        const observedAt = new Date().toISOString();
        return zcodeMcpListResultSchema.parse({
          statuses: Object.fromEntries(
            rows
              .filter((row) => !names || names.includes(row.name))
              .map((row) => [
                row.name,
                {
                  status: row.enabled ? row.status : "disconnected",
                  transport: row.kind,
                  toolCount: row.toolCount,
                  updatedAt: observedAt,
                  ...(row.error
                    ? { error: row.error, failureKind: "connection_failed" }
                    : {}),
                },
              ]),
          ),
        });
      },
    },
  };
}
