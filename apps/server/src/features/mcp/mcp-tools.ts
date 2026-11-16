import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { contributionFingerprint } from "../../kernel/contribution-fingerprint.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
  ToolScope,
} from "../../kernel/types.js";
import {
  refreshMcpScope,
  TaskMcpError,
  taskMcpContext,
} from "./task-mcp-context.js";

/**
 * MCP 工具注册逻辑（P4d，纯函数可测）：
 * server 工具按 `mcp__<server>__<tool>` 命名进 ctx.tools（§4.5 命名约定）。
 * 连接由 features/mcp/plugin.ts 经官方 SDK 完成，此处只做契约映射。
 */

export interface McpServerToolLike {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export const mcpAppView = Symbol("mcp-app-view");
export type McpToolCallResult = CallToolResult & {
  [mcpAppView]?: { ref: string; serverName: string; toolName: string };
};

const toolMetadataSchema = z.object({
  ui: z
    .object({
      visibility: z.array(z.enum(["model", "app"])).optional(),
      resourceUri: z.unknown().optional(),
    })
    .optional(),
  "ui/resourceUri": z.unknown().optional(),
  "openai/outputTemplate": z.unknown().optional(),
});

export const isMcpAppResource = (uri: string) =>
  uri.trimStart().toLowerCase().startsWith("ui:");

export function mcpAppResourceUri(tool: McpServerToolLike): string | undefined {
  const parsed = toolMetadataSchema.safeParse(tool._meta ?? {});
  if (!parsed.success) return undefined;
  const meta = parsed.data;
  const uri =
    meta.ui?.resourceUri ??
    meta["ui/resourceUri"] ??
    meta["openai/outputTemplate"];
  return typeof uri === "string" && isMcpAppResource(uri) ? uri : undefined;
}

export function mcpToolContractVersion(tool: McpServerToolLike): string {
  return mcpConfigurationVersion({
    name: tool.name,
    inputSchema: tool.inputSchema,
    appResourceUri: mcpAppResourceUri(tool),
  });
}

function projectContent(block: ContentBlock): ContentBlock[] {
  const { _meta: _blockMetadata, ...content } = block;
  if (content.type === "resource") {
    const { _meta: _resourceMetadata, ...resource } = content.resource;
    return isMcpAppResource(resource.uri) ? [] : [{ ...content, resource }];
  }
  if (content.type === "resource_link" && isMcpAppResource(content.uri))
    return [];
  return [content];
}

/** MCP Apps 的可见范围独立于页面资源；只有未声明时默认向模型开放。 */
export function isModelVisibleMcpTool(tool: McpServerToolLike): boolean {
  const parsed = toolMetadataSchema.safeParse(tool._meta ?? {});
  if (!parsed.success)
    throw new TaskMcpError(
      "mcp_visibility_invalid",
      "MCP工具调用范围无效，请检查服务端工具声明。",
    );
  const visibility = parsed.data.ui?.visibility;
  return visibility === undefined || visibility.includes("model");
}

export function assertModelVisibleMcpTool(tool: McpServerToolLike): void {
  if (!isModelVisibleMcpTool(tool))
    throw new TaskMcpError(
      "mcp_tool_not_model_visible",
      "MCP工具未向模型开放，请检查工具声明。",
      403,
    );
}

export interface McpClientLike {
  listTools(): Promise<{ tools: McpServerToolLike[] }>;
  callTool(
    args: {
      name: string;
      arguments?: Record<string, unknown>;
    },
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<McpToolCallResult>;
}

export function callMcpTool(
  client: Client,
  params: Parameters<Client["callTool"]>[0],
  options: RequestOptions,
): Promise<CallToolResult> {
  // SDK 在这里按显式 schema 校验；类型声明仍包含未选用的历史兼容 schema。
  return client.callTool(
    params,
    CallToolResultSchema,
    options,
  ) as Promise<CallToolResult>;
}

export function toKernelTool(
  serverName: string,
  tool: McpServerToolLike,
  client: McpClientLike,
): ToolDefinition {
  return createMcpToolDefinition(
    serverName,
    tool,
    "shared",
    async (args, context) => {
      await refreshMcpScope(taskMcpContext(context));
      return client.callTool(
        { name: tool.name, arguments: args },
        context.signal,
        context,
      );
    },
  );
}

/** Only this digest enters capability snapshots; credentials stay in source configuration. */
export function mcpConfigurationVersion(value: unknown): string {
  return contributionFingerprint(value);
}

/** CUA dispatch also uses this fence; its generic tool cannot borrow a changed MCP source. */
export function assertMcpContribution(
  registry: ToolRegistry,
  id: string,
  context: ToolExecutionContext,
): void {
  const frozen = context.frozenContributions;
  if (!frozen) return;
  const expected = frozen.entries.find(
    (entry) => entry.kind === "dynamic" && entry.id === id,
  );
  const current = registry
    .captureContributions(frozen.preset)
    .entries.find((entry) => entry.kind === "dynamic" && entry.id === id);
  if (!expected || expected.signature !== current?.signature)
    throw new Error("MCP工具或配置已改变，请发起新运行。");
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
  execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<McpToolCallResult>,
): ToolDefinition {
  assertModelVisibleMcpTool(tool);
  const app = mcpAppResourceUri(tool) !== undefined;
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name}`,
    scope,
    exposure: "deferred",
    // 外部readOnlyHint不是本机权限证明；未知效果按执行策略做人审。
    access: "execute",
    projectArguments: projectMcpArguments,
    parameters: tool.inputSchema ?? { type: "object" },
    async execute(args, context) {
      // 模型与通用运行记录共用这个出口；不转交页面专用字段。
      const result = await execute(args, context);
      const output = {
        content: result.content.flatMap(projectContent),
        ...(!app && result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
      const view = result[mcpAppView];
      return view ? {
        canonicalOutput: output,
        modelContent: [{ type: "text", text: JSON.stringify(output) }],
        display: {
          kind: "mcp_tool",
          serverName: view.serverName,
          toolName: view.toolName,
          appRef: view.ref,
        },
      } : output;
    },
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
  configurationVersion: string,
): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (const metadata of tools.filter(isModelVisibleMcpTool)) {
      const tool = toKernelTool(serverName, metadata, client);
      disposers.push(
        registry.registerDynamic({
          id: `mcp:instance:${tool.name}`,
          scope: "shared",
          configurationVersion: mcpConfigurationVersion({
            configurationVersion,
            contract: mcpToolContractVersion(metadata),
          }),
          resolve(run) {
            const handle = run.scopeHandle;
            if (
              !handle ||
              handle.role === "explore" ||
              handle.role === "review" ||
              handle.describe().sandboxMode === "read-only"
            )
              return null;
            return tool;
          },
        }),
      );
    }
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
