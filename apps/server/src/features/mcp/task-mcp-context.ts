import type { CodeExecutionScope } from "@kenfutwork/shared";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";

const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
      "MCP名称只能含字母、数字、点、下划线和连字符。",
    ),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().trim().min(1).optional(),
};
export const taskMcpInstallSchema = z
  .object({ ...fields, command: z.string().trim().min(1) })
  .strict();
export const taskMcpCreateSchema = z
  .object({
    ...fields,
    command: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1),
  })
  .strict();

export interface McpTaskContext {
  handle: ExecutionScopeHandle;
  actor: AuthenticatedUser;
  scope: CodeExecutionScope;
  branchGeneration: number;
  runId: string;
  toolCallId: string;
  signal?: AbortSignal;
}

export class TaskMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "TaskMcpError";
  }
}

export function taskMcpContext(
  context: ToolExecutionContext,
  writable = true,
): McpTaskContext {
  const handle = context.scopeHandle;
  const work = context.taskWorkContext;
  if (
    !handle ||
    !work?.actor ||
    !context.runId ||
    !context.toolCallId ||
    !context.userId
  )
    throw new TaskMcpError(
      "mcp_context_required",
      "MCP操作缺少可信Task工作域与逐调用身份。",
      403,
    );
  const scope = handle.describe();
  if (
    work.actor.id !== context.userId ||
    work.scope.workspaceId !== scope.workspaceId ||
    work.scope.taskId !== scope.taskId ||
    work.scope.projectId !== scope.projectId ||
    !Number.isSafeInteger(work.branchGeneration) ||
    work.branchGeneration < 1
  )
    throw new TaskMcpError(
      "mcp_owner_mismatch",
      "MCP调用的Task、工作区或用户身份不匹配。",
      403,
    );
  if (
    writable &&
    (handle.role === "explore" ||
      handle.role === "review" ||
      scope.sandboxMode === "read-only")
  )
    throw new TaskMcpError(
      "mcp_readonly",
      "只读角色或Task不能创建/调用未知效果的MCP进程。",
      403,
    );
  return {
    handle,
    actor: work.actor,
    scope,
    branchGeneration: work.branchGeneration,
    runId: context.runId,
    toolCallId: context.toolCallId,
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

export async function refreshMcpScope(
  context: McpTaskContext,
  writable = true,
): Promise<void> {
  context.signal?.throwIfAborted();
  await context.handle.resolvePath(".", writable ? "write" : "read");
  context.scope = context.handle.describe();
  context.signal?.throwIfAborted();
}

export function mcpFailure(
  error: unknown,
  env: Record<string, string>,
  fallback: string,
): TaskMcpError {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : fallback;
  const clean = Object.values(env)
    .filter(Boolean)
    .reduce((value, secret) => value.split(secret).join("[已隐藏]"), message);
  return new TaskMcpError(code, clean, code === "stop_unconfirmed" ? 503 : 409);
}
