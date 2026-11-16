import { RequestIdSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import {
  executeApprovedMcpAppOperation,
  type McpAppExecution,
  type McpAppSource,
} from "./mcp-app-approval.js";
import {
  callMcpTool,
  isAppVisibleMcpTool,
  mcpToolContractVersion,
  projectMcpArguments,
} from "./mcp-tools.js";

const requestSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    requestId: RequestIdSchema,
  })
  .strict();

const toolUnavailable = () =>
  new CodeUiHostRpcError(
    "mcp_app_tool_unavailable",
    "插件页面无权调用此工具。",
    403,
  );

export async function listMcpAppTools(
  source: McpAppSource,
  cursor: string | undefined,
  signal: AbortSignal,
) {
  const result = await source.client.listTools(
    cursor === undefined ? undefined : { cursor },
    await source.options(signal),
  );
  return { ...result, tools: result.tools.filter(isAppVisibleMcpTool) };
}

async function findMcpAppTool(
  source: McpAppSource,
  name: string,
  signal: AbortSignal,
) {
  const options = await source.options(signal);
  const discoverySignal = options.timeout
    ? AbortSignal.any([signal, AbortSignal.timeout(options.timeout)])
    : signal;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    discoverySignal.throwIfAborted();
    if (cursor !== undefined) seen.add(cursor);
    const page = await source.client.listTools(
      cursor === undefined ? undefined : { cursor },
      { ...options, signal: discoverySignal },
    );
    const tool = page.tools.find(
      (item) => item.name === name && isAppVisibleMcpTool(item),
    );
    if (tool) return tool;
    cursor = page.nextCursor;
  } while (cursor !== undefined && !seen.has(cursor));
  throw toolUnavailable();
}

export async function executeMcpAppTool(
  input: McpAppExecution,
  requested: unknown,
) {
  const {
    source,
    authorization: { serverName },
    signal,
  } = input;
  const { name, arguments: raw, requestId } = requestSchema.parse(requested);
  const tool = await findMcpAppTool(source, name, signal);
  const parameters: Record<string, unknown> = tool.inputSchema;
  const schema = z.fromJSONSchema(parameters);
  const args = z.record(z.string(), z.unknown()).parse(schema.parse(raw));
  return executeApprovedMcpAppOperation(input, {
    requestId,
    toolName: `mcp__${serverName}__${tool.name}`,
    args,
    displayArgs: projectMcpArguments(args),
    display: { kind: "mcp_tool", serverName, toolName: tool.name },
    summary: `插件页面请求调用 ${tool.name}`,
    async revalidate() {
      const current = await findMcpAppTool(source, name, signal);
      if (mcpToolContractVersion(tool) !== mcpToolContractVersion(current))
        throw toolUnavailable();
    },
    execute: (options) =>
      callMcpTool(source.client, { name, arguments: args }, options),
  });
}
