import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  CodeApprovalService,
  PermissionInvocation,
} from "../permissions/approval-types.js";
import {
  callMcpTool,
  isAppVisibleMcpTool,
  mcpConfigurationVersion,
  mcpToolContractVersion,
  projectMcpArguments,
} from "./mcp-tools.js";

export interface McpAppSource {
  client: Client;
  current(): boolean;
  options(signal: AbortSignal): Promise<RequestOptions>;
}

const requestSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    requestId: z.union([z.string(), z.number()]),
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

export async function executeMcpAppTool(input: {
  source: McpAppSource;
  authorization: {
    handle: NonNullable<ToolExecutionContext["scopeHandle"]>;
    approval: NonNullable<ToolExecutionContext["codeApproval"]>;
    runId: string;
    serverName: string;
  };
  permissions: CodeApprovalService;
  viewId: string;
  requested: unknown;
  requireLive(): Promise<void>;
  signal: AbortSignal;
}) {
  const { source, permissions, authorization, requireLive, signal } = input;
  const { handle, approval, runId, serverName } = authorization;
  const {
    name,
    arguments: raw,
    requestId,
  } = requestSchema.parse(input.requested);
  const tool = await findMcpAppTool(source, name, signal);
  const parameters: Record<string, unknown> = tool.inputSchema;
  const schema = z.fromJSONSchema(parameters);
  const args = z.record(z.string(), z.unknown()).parse(schema.parse(raw));
  const readMode = async () => {
    await requireLive();
    await handle.resolvePath(".", "write");
    const policy = await approval.resolve();
    signal.throwIfAborted();
    const scope = handle.describe();
    if (
      policy.branchGeneration !== handle.branchGeneration ||
      policy.scopeGeneration !== scope.generation ||
      handle.role === "explore" ||
      handle.role === "review"
    )
      throw toolUnavailable();
    return { scope, mode: policy.mode };
  };
  const { scope, mode } = await readMode();
  const toolCallId = `mcp-app:${mcpConfigurationVersion([input.viewId, requestId])}`;
  const invocation: PermissionInvocation = {
    instanceId: scope.instanceId,
    taskId: scope.taskId,
    preset: handle.preset,
    runId,
    toolCallId,
    agentId: handle.agentId,
    role: handle.role,
    scopeGeneration: scope.generation,
    branchGeneration: handle.branchGeneration,
    mode,
    approvalCeiling: approval.ceiling,
    toolName: `mcp__${serverName}__${tool.name}`,
    args,
    displayArgs: projectMcpArguments(args),
    display: { kind: "mcp_tool", serverName, toolName: tool.name },
    summary: `插件页面请求调用 ${tool.name}`,
    access: "execute",
    signal,
  };
  const deny = () =>
    new CodeUiHostRpcError(
      "mcp_app_tool_denied",
      "Task 未允许插件工具执行。",
      403,
    );
  if ((await permissions.admit(invocation)).decision !== "allow") throw deny();
  try {
    const currentTool = await findMcpAppTool(source, name, signal);
    if (mcpToolContractVersion(tool) !== mcpToolContractVersion(currentTool))
      throw toolUnavailable();
    if ((await permissions.revalidate(invocation)).decision !== "allow")
      throw deny();
    const options = await source.options(signal);
    const current = await readMode();
    if (
      permissions.claim({ ...invocation, mode: current.mode }).decision !==
      "allow"
    )
      throw deny();
    const result = await callMcpTool(
      source.client,
      { name, arguments: args },
      options,
    );
    await requireLive();
    return result;
  } catch (error) {
    await permissions.cancel(
      { instanceId: scope.instanceId, taskId: scope.taskId, runId, toolCallId },
      "插件页面的工具授权已结束。",
    );
    throw error;
  }
}
