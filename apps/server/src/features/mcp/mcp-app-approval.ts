import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  CodeApprovalService,
  PermissionInvocation,
} from "../permissions/approval-types.js";
import { mcpConfigurationVersion } from "./mcp-tools.js";

export interface McpAppSource {
  client: Client;
  current(): boolean;
  options(signal: AbortSignal): Promise<RequestOptions>;
}

export interface McpAppAuthorization {
  handle: NonNullable<ToolExecutionContext["scopeHandle"]>;
  approval: NonNullable<ToolExecutionContext["codeApproval"]>;
  runId: string;
  serverName: string;
}

export interface McpAppExecution {
  source: McpAppSource;
  authorization: McpAppAuthorization;
  permissions: CodeApprovalService;
  viewId: string;
  requireLive(): Promise<void>;
  signal: AbortSignal;
}

/** 正文读取和调用工具走同一 Task 审批，原始参数仅用于绑定授权与执行。 */
export async function executeApprovedMcpAppOperation<T>(
  input: McpAppExecution,
  operation: Pick<
    PermissionInvocation,
    "toolName" | "summary" | "args" | "displayArgs" | "display"
  > & {
    requestId: RequestId;
    revalidate?(): Promise<void>;
    execute(options: RequestOptions): Promise<T>;
  },
) {
  const { source, permissions, authorization, requireLive, signal } = input;
  const { handle, approval, runId } = authorization;
  const deny = () =>
    new CodeUiHostRpcError(
      "mcp_app_operation_denied",
      "当前任务未允许此插件操作。",
      403,
    );
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
      throw deny();
    return { scope, mode: policy.mode };
  };
  const { scope, mode } = await readMode();
  const toolCallId = `mcp-app:${mcpConfigurationVersion([input.viewId, operation.requestId])}`;
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
    toolName: operation.toolName,
    args: operation.args,
    displayArgs: operation.displayArgs,
    display: operation.display,
    summary: operation.summary,
    access: "execute",
    signal,
  };
  if ((await permissions.admit(invocation)).decision !== "allow") throw deny();
  try {
    await operation.revalidate?.();
    if ((await permissions.revalidate(invocation)).decision !== "allow")
      throw deny();
    const options = await source.options(signal);
    const current = await readMode();
    if (
      permissions.claim({ ...invocation, mode: current.mode }).decision !==
      "allow"
    )
      throw deny();
    const result = await operation.execute(options);
    await requireLive();
    return result;
  } catch (error) {
    await permissions.cancel(
      { instanceId: scope.instanceId, taskId: scope.taskId, runId, toolCallId },
      "插件页面的操作授权已结束。",
    );
    throw error;
  }
}
