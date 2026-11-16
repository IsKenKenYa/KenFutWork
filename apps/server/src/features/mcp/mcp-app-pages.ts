import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type CallToolResult,
  RequestIdSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import {
  type CodeUiHostRpcContext,
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeApprovalService } from "../permissions/approval-types.js";
import {
  executeApprovedMcpAppOperation,
  type McpAppAuthorization,
  type McpAppExecution,
  type McpAppSource,
} from "./mcp-app-approval.js";
import { executeMcpAppTool, listMcpAppTools } from "./mcp-app-tools.js";
import {
  type McpServerToolLike,
  mcpAppResourceUri,
  mcpAppView,
} from "./mcp-tools.js";

// ZCode 的 HTML 资源上限；同时限制仅在连接存续期保留的私有消息总量。
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 128;
const MIMES = new Set(["text/html;profile=mcp-app", "text/html"]);
export const mcpAppClientCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};

const referenceSchema = z
  .object({ ref: z.uuid(), toolCallId: z.string().min(1) })
  .strict();
const resourceRequestSchema = z
  .object({
    uri: z.string().refine((uri) => URL.canParse(uri)),
    requestId: RequestIdSchema,
  })
  .strict();
const pageRequestSchema = z.object({ cursor: z.string().optional() }).strict();

type McpAppMethod =
  | "listTools"
  | "callTool"
  | "listResources"
  | "listResourceTemplates"
  | "readResource";

function readMcpAppResource(input: McpAppExecution, requested: unknown) {
  const { uri, requestId } = resourceRequestSchema.parse(requested);
  const { serverName } = input.authorization;
  const displayUri = new URL(uri);
  displayUri.username = "";
  displayUri.password = "";
  displayUri.search = "";
  displayUri.hash = "";
  return executeApprovedMcpAppOperation(input, {
    requestId,
    toolName: `mcp__${serverName}__read_resource`,
    summary: "插件页面请求读取资源",
    args: { uri },
    displayArgs: {
      uri: displayUri.href.startsWith(`${displayUri.protocol}//`)
        ? displayUri.href
        : displayUri.protocol,
    },
    display: { kind: "mcp_tool", serverName, toolName: "read_resource" },
    // URI 是原 MCP 服务的资源标识，不交给本机文件系统或网络请求。
    execute: (options) => input.source.client.readResource({ uri }, options),
  });
}

export function createMcpAppPages(
  getPermissions: () => CodeApprovalService | undefined,
) {
  type Entry = {
    source: McpAppSource;
    uri: string;
    toolCallId: string;
    handle: NonNullable<ToolExecutionContext["scopeHandle"]>;
    scope: ReturnType<
      NonNullable<ToolExecutionContext["scopeHandle"]>["describe"]
    >;
    payload: string;
    bytes: number;
    invalidated: AbortController;
    authorization?: McpAppAuthorization;
  };
  type View = {
    id: string;
    ref: string;
    connectionId: string;
    abort: AbortController;
    close(): void;
  };
  const pages = new Map<string, Entry>();
  const views = new Map<string, View>();
  let bytes = 0;

  function remove(ref: string, entry: Entry) {
    if (!pages.delete(ref)) return;
    bytes -= entry.bytes;
    entry.invalidated.abort();
    for (const view of views.values()) if (view.ref === ref) view.close();
  }

  function capture(input: {
    source: McpAppSource;
    tool: McpServerToolLike;
    serverName: string;
    context: ToolExecutionContext;
    args: Record<string, unknown>;
    result: CallToolResult;
  }) {
    const { source, tool, context, args, result, serverName } = input;
    const uri = mcpAppResourceUri(tool);
    const handle = context.scopeHandle;
    if (
      !uri?.startsWith("ui://") ||
      !handle ||
      !context.runId ||
      !context.toolCallId ||
      result.isError ||
      context.signal?.aborted ||
      !source.current() ||
      !source.client.getServerCapabilities()?.resources
    )
      return result;

    const scope = handle.describe();
    const { content, structuredContent, _meta } = result;
    const payload = JSON.stringify({
      arguments: args,
      result: { content, structuredContent, _meta },
    });
    const size = Buffer.byteLength(payload);
    if (size > MAX_PAGE_BYTES) return result;
    while (pages.size >= MAX_RESULTS || bytes + size > MAX_PAGE_BYTES) {
      const oldest = pages.entries().next().value;
      if (!oldest) break;
      remove(...oldest);
    }
    const ref = randomUUID();
    pages.set(ref, {
      source,
      uri,
      toolCallId: `${context.runId}/${context.toolCallId}`,
      handle,
      scope,
      payload,
      bytes: size,
      invalidated: new AbortController(),
      ...(context.codeApproval
        ? {
            authorization: {
              handle,
              approval: context.codeApproval,
              runId: context.runId,
              serverName,
            },
          }
        : {}),
    });
    bytes += size;
    return {
      ...result,
      [mcpAppView]: { ref, serverName, toolName: tool.name },
    };
  }

  async function requirePage(
    actor: LocalActor,
    requested: unknown,
    signal: AbortSignal,
  ) {
    const { ref, toolCallId } = referenceSchema.parse(requested);
    const entry = pages.get(ref);
    if (
      !entry ||
      entry.scope.instanceId !== actor.instanceId ||
      entry.toolCallId !== toolCallId
    )
      throw new CodeUiHostRpcError(
        "mcp_app_unavailable",
        "插件页面已失效，请重新运行工具。",
        404,
      );
    signal.throwIfAborted();
    await entry.handle.resolvePath(".", "read");
    signal.throwIfAborted();
    const scope = entry.handle.describe();
    if (
      pages.get(ref) !== entry ||
      !entry.source.current() ||
      scope.taskId !== entry.scope.taskId ||
      scope.projectId !== entry.scope.projectId ||
      scope.generation !== entry.scope.generation
    )
      throw new CodeUiHostRpcError(
        "mcp_app_unavailable",
        "插件页面已失效，请重新运行工具。",
        404,
      );
    return entry;
  }

  async function open(
    actor: LocalActor,
    requested: unknown,
    context: CodeUiHostRpcContext,
  ) {
    const signal = requestSignal(context);
    const entry = await requirePage(actor, requested, signal);
    const readSignal = AbortSignal.any([signal, entry.invalidated.signal]);
    const response = await entry.source.client
      .readResource({ uri: entry.uri }, await entry.source.options(readSignal))
      .catch(() => {
        throw new CodeUiHostRpcError(
          "mcp_app_unavailable",
          "插件页面读取失败，请检查连接后重试。",
          404,
        );
      });
    await requirePage(actor, requested, signal);
    const document = response.contents.find(
      (item) => item.uri === entry.uri && "text" in item,
    );
    if (
      !document ||
      !("text" in document) ||
      !MIMES.has(document.mimeType ?? "") ||
      Buffer.byteLength(document.text) > MAX_PAGE_BYTES
    )
      throw new CodeUiHostRpcError(
        "mcp_app_invalid_page",
        "无法读取插件页面，请检查插件资源。",
        422,
      );
    const { ref } = referenceSchema.parse(requested);
    if (views.size >= MAX_RESULTS) views.values().next().value?.close();
    const viewId = randomUUID();
    const abort = new AbortController();
    const close = () => {
      abort.abort();
      views.delete(viewId);
      release();
    };
    const release = context.onClose(close);
    views.set(viewId, {
      id: viewId,
      ref,
      connectionId: context.connectionId,
      abort,
      close,
    });
    const interactive = Boolean(entry.authorization && getPermissions());
    const capabilities = entry.source.client.getServerCapabilities();
    return {
      html: document.text,
      ...JSON.parse(entry.payload),
      viewId,
      serverTools: interactive && Boolean(capabilities?.tools),
      serverResources: interactive && Boolean(capabilities?.resources),
    };
  }

  const requestSignal = (context: CodeUiHostRpcContext) =>
    context.requestSignal
      ? AbortSignal.any([context.requestSignal, context.signal])
      : context.signal;

  function requireView(id: unknown, context: CodeUiHostRpcContext): View {
    const view = typeof id === "string" ? views.get(id) : undefined;
    if (!view || view.connectionId !== context.connectionId)
      throw new CodeUiHostRpcError(
        "mcp_app_unavailable",
        "插件页面已失效，请重新运行工具。",
        404,
      );
    return view;
  }

  function operationHandler(method: McpAppMethod): CodeUiHostRpcHandler {
    return {
      call(actor, args, context) {
        return runCodeUiHostRpc(context, async () => {
          const view = requireView(args[0], context);
          const signal = AbortSignal.any([
            requestSignal(context),
            view.abort.signal,
          ]);
          const entry = pages.get(view.ref);
          const requested = { ref: view.ref, toolCallId: entry?.toolCallId };
          const requireLive = async () => {
            await requirePage(actor, requested, signal);
          };
          try {
            await requireLive();
            const permissions = getPermissions();
            const capability =
              method === "listTools" || method === "callTool"
                ? "tools"
                : "resources";
            if (
              !entry?.authorization ||
              !permissions ||
              !entry.source.client.getServerCapabilities()?.[capability]
            )
              throw new CodeUiHostRpcError(
                "mcp_app_operation_unavailable",
                "此页面不能执行该操作。",
                403,
              );
            const execution = {
              source: entry.source,
              authorization: entry.authorization,
              permissions,
              requireLive,
              viewId: view.id,
              signal,
            };
            if (method === "callTool")
              return await executeMcpAppTool(execution, args[1]);
            if (method === "readResource")
              return await readMcpAppResource(execution, args[1]);
            const { cursor } = pageRequestSchema.parse(args[1]);
            if (method === "listTools") {
              const result = await listMcpAppTools(
                entry.source,
                cursor,
                signal,
              );
              await requireLive();
              return result;
            }
            const options = await entry.source.options(signal);
            const params = cursor === undefined ? undefined : { cursor };
            const result =
              method === "listResources"
                ? await entry.source.client.listResources(params, options)
                : await entry.source.client.listResourceTemplates(
                    params,
                    options,
                  );
            await requireLive();
            return result;
          } catch (error) {
            if (error instanceof CodeUiHostRpcError) throw error;
            throw new CodeUiHostRpcError(
              "mcp_app_operation_failed",
              "插件操作失败，请检查插件或重新打开页面。",
              422,
            );
          }
        });
      },
    };
  }

  const handlers: Record<string, CodeUiHostRpcHandler> = {
    "mcp-apps.open": {
      call(actor, args, context) {
        return runCodeUiHostRpc(context, () => open(actor, args[0], context));
      },
    },
    "mcp-apps.waitForClose": {
      call(_actor, args, context) {
        return runCodeUiHostRpc(context, async () => {
          const request = requestSignal(context);
          const view = views.get(typeof args[0] === "string" ? args[0] : "");
          if (!view || view.connectionId !== context.connectionId) return null;
          const signal = AbortSignal.any([view.abort.signal, request]);
          try {
            if (!signal.aborted)
              await new Promise<void>((resolve) => {
                const listener = addAbortListener(signal, () => {
                  listener[Symbol.dispose]();
                  resolve();
                });
              });
            return null;
          } finally {
            view.close();
          }
        });
      },
    },
    "mcp-apps.listTools": operationHandler("listTools"),
    "mcp-apps.callTool": operationHandler("callTool"),
    "mcp-apps.listResources": operationHandler("listResources"),
    "mcp-apps.listResourceTemplates": operationHandler("listResourceTemplates"),
    "mcp-apps.readResource": operationHandler("readResource"),
  };

  return {
    capture,
    handlers,
    closeSource(client: Client) {
      for (const [ref, entry] of pages)
        if (entry.source.client === client) remove(ref, entry);
    },
    closeTask(instanceId: string, taskId: string) {
      for (const [ref, entry] of pages)
        if (
          entry.scope.instanceId === instanceId &&
          entry.scope.taskId === taskId
        )
          remove(ref, entry);
    },
  };
}

export type McpAppPages = ReturnType<typeof createMcpAppPages>;
