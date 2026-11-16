import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { InstanceSettings } from "@kenfutwork/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type CallToolResult,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
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
import type { McpAppAuthorization, McpAppSource } from "./mcp-app-approval.js";
import {
  createMcpAppSubscriptions,
  readMcpAppResource,
} from "./mcp-app-resources.js";
import { executeMcpAppTool, listMcpAppTools } from "./mcp-app-tools.js";
import {
  type McpServerToolLike,
  mcpAppResourceUri,
  mcpAppView,
} from "./mcp-tools.js";

const MIMES = new Set(["text/html;profile=mcp-app", "text/html"]);
type McpAppLimits = Pick<InstanceSettings, "mcpAppMaxBytes" | "mcpAppMaxPages">;
export const mcpAppClientCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};

const referenceSchema = z
  .object({ ref: z.uuid(), toolCallId: z.string().min(1) })
  .strict();
const pageRequestSchema = z.object({ cursor: z.string().optional() }).strict();
const catalogVersionSchema = z
  .object({
    tools: z.int().nonnegative().optional(),
    resources: z.int().nonnegative().optional(),
    subscriptions: z.record(z.string(), z.int().nonnegative()).optional(),
  })
  .strict();

type McpAppMethod =
  | "listTools"
  | "callTool"
  | "listResources"
  | "listResourceTemplates"
  | "readResource"
  | "subscribeResource"
  | "unsubscribeResource";

const reportCloseFailure = () =>
  console.warn("[mcp] 插件页面资源退订未确认，请检查 MCP 连接。");

export function createMcpAppPages(
  getPermissions: () => CodeApprovalService | undefined,
  resolveLimits: (actor: LocalActor) => Promise<McpAppLimits>,
) {
  type Entry = {
    source: McpAppSource;
    uri: string;
    toolCallId: string;
    handle: NonNullable<ToolExecutionContext["scopeHandle"]>;
    scope: ReturnType<
      NonNullable<ToolExecutionContext["scopeHandle"]>["describe"]
    >;
    payload: string | null;
    bytes: number;
    invalidated: AbortController;
    authorization?: McpAppAuthorization;
  };
  type View = {
    id: string;
    ref: string;
    connectionId: string;
    abort: AbortController;
    changed: AbortController;
    close(): Promise<void>;
  };
  const pages = new Map<string, Entry>();
  const views = new Map<string, View>();
  const subscriptions = createMcpAppSubscriptions((viewId) => {
    const view = views.get(viewId);
    if (!view) return;
    const previous = view.changed;
    view.changed = new AbortController();
    previous.abort();
  });
  const catalogs = new WeakMap<
    Client,
    {
      versions: { tools: number; resources: number };
      changed: AbortController;
    }
  >();
  let bytes = 0;

  function observeSource(client: Client) {
    const state = {
      versions: { tools: 0, resources: 0 },
      changed: new AbortController(),
    };
    catalogs.set(client, state);
    const change = (kind: "tools" | "resources") => {
      if (
        catalogs.get(client) !== state ||
        !client.getServerCapabilities()?.[kind]?.listChanged
      )
        return;
      state.versions[kind] += 1;
      const previous = state.changed;
      state.changed = new AbortController();
      previous.abort();
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      change("tools"),
    );
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
      change("resources"),
    );
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      ({ params }) => subscriptions.updated(client, params.uri),
    );
  }

  function catalogVersions(entry: Entry) {
    const state = catalogs.get(entry.source.client);
    const capabilities = entry.source.client.getServerCapabilities();
    if (!state || !entry.authorization || !getPermissions()) return {};
    return {
      ...(capabilities?.tools?.listChanged
        ? { tools: state.versions.tools }
        : {}),
      ...(capabilities?.resources?.listChanged
        ? { resources: state.versions.resources }
        : {}),
    };
  }

  function remove(ref: string, entry: Entry) {
    if (!pages.delete(ref)) return;
    bytes -= entry.bytes;
    entry.invalidated.abort();
    for (const view of views.values())
      if (view.ref === ref) void view.close().catch(reportCloseFailure);
  }

  async function capture(input: {
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
      !context.actor ||
      !context.runId ||
      !context.toolCallId ||
      result.isError ||
      context.signal?.aborted ||
      !source.current() ||
      !source.client.getServerCapabilities()?.resources
    )
      return result;

    const limits = await resolveLimits(context.actor);
    if (context.signal?.aborted || !source.current()) return result;
    const scope = handle.describe();
    const { content, structuredContent, _meta } = result;
    const payload = JSON.stringify({
      arguments: args,
      result: { content, structuredContent, _meta },
    });
    const size = Buffer.byteLength(payload);
    const retained = size <= limits.mcpAppMaxBytes;
    const retainedBytes = retained ? size : 0;
    while (
      pages.size >= limits.mcpAppMaxPages ||
      bytes + retainedBytes > limits.mcpAppMaxBytes
    ) {
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
      payload: retained ? payload : null,
      bytes: retainedBytes,
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
    bytes += retainedBytes;
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
    const limits = await resolveLimits(actor);
    if (entry.payload === null)
      throw new CodeUiHostRpcError(
        "mcp_app_limit_exceeded",
        "页面结果过大，请调大容量后重新运行工具。",
        413,
      );
    requireViewCapacity(limits.mcpAppMaxPages);
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
      !MIMES.has(document.mimeType ?? "")
    )
      throw new CodeUiHostRpcError(
        "mcp_app_invalid_page",
        "无法读取插件页面，请检查插件资源。",
        422,
      );
    if (
      entry.bytes > limits.mcpAppMaxBytes ||
      Buffer.byteLength(document.text) > limits.mcpAppMaxBytes
    )
      throw new CodeUiHostRpcError(
        "mcp_app_limit_exceeded",
        "插件页面超过容量限制，请在 Agent 治理中调大。",
        413,
      );
    const { ref } = referenceSchema.parse(requested);
    requireViewCapacity(limits.mcpAppMaxPages);
    const viewId = randomUUID();
    const abort = new AbortController();
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      abort.abort();
      views.delete(viewId);
      release();
      closing = subscriptions.closeView(viewId);
      return closing;
    };
    const release = context.onClose(() => close().catch(reportCloseFailure));
    views.set(viewId, {
      id: viewId,
      ref,
      connectionId: context.connectionId,
      abort,
      changed: new AbortController(),
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
      resourceSubscribe:
        interactive && Boolean(capabilities?.resources?.subscribe),
      catalogs: catalogVersions(entry),
    };
  }

  function requireViewCapacity(maxPages: number) {
    if (views.size >= maxPages)
      throw new CodeUiHostRpcError(
        "mcp_app_limit_exceeded",
        "打开的插件页面已达上限，请关闭部分页面。",
        429,
      );
  }

  const requestSignal = (context: CodeUiHostRpcContext) =>
    context.requestSignal
      ? AbortSignal.any([context.requestSignal, context.signal])
      : context.signal;

  function readView(id: unknown, context: CodeUiHostRpcContext) {
    const view = typeof id === "string" ? views.get(id) : undefined;
    return view?.connectionId === context.connectionId ? view : undefined;
  }

  function requireView(id: unknown, context: CodeUiHostRpcContext): View {
    const view = readView(id, context);
    if (!view)
      throw new CodeUiHostRpcError(
        "mcp_app_unavailable",
        "插件页面已失效，请重新运行工具。",
        404,
      );
    return view;
  }

  async function watch(
    actor: LocalActor,
    args: unknown[],
    context: CodeUiHostRpcContext,
  ) {
    const request = requestSignal(context);
    const view = readView(args[0], context);
    if (!view) return null;
    const entry = pages.get(view.ref);
    if (!entry) return null;
    const cursor = catalogVersionSchema.parse(args[1]);
    const lifetime = AbortSignal.any([view.abort.signal, request]);
    const requested = { ref: view.ref, toolCallId: entry.toolCallId };
    try {
      await requirePage(actor, requested, lifetime);
      const current = {
        ...catalogVersions(entry),
        ...subscriptions.versions(view.id),
      };
      if (JSON.stringify(current) !== JSON.stringify(cursor)) return current;
      const changed =
        current.tools !== undefined || current.resources !== undefined
          ? catalogs.get(entry.source.client)?.changed.signal
          : undefined;
      const signal = AbortSignal.any([
        lifetime,
        view.changed.signal,
        ...(changed ? [changed] : []),
      ]);
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const listener = addAbortListener(signal, () => {
            listener[Symbol.dispose]();
            resolve();
          });
        });
      if (lifetime.aborted) return null;
      await requirePage(actor, requested, lifetime);
      return { ...catalogVersions(entry), ...subscriptions.versions(view.id) };
    } catch (error) {
      if (lifetime.aborted) return null;
      await view.close();
      throw error;
    } finally {
      if (lifetime.aborted) await view.close();
    }
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
            if (method === "subscribeResource")
              return await subscriptions.subscribe(execution, args[1]);
            if (method === "unsubscribeResource")
              return await subscriptions.unsubscribe(view.id, args[1]);
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
    "mcp-apps.watch": {
      call(actor, args, context) {
        return runCodeUiHostRpc(context, () => watch(actor, args, context));
      },
    },
    "mcp-apps.close": {
      call(_actor, args, context) {
        return runCodeUiHostRpc(context, async () => {
          await readView(args[0], context)?.close();
          return null;
        });
      },
    },
    "mcp-apps.listTools": operationHandler("listTools"),
    "mcp-apps.callTool": operationHandler("callTool"),
    "mcp-apps.listResources": operationHandler("listResources"),
    "mcp-apps.listResourceTemplates": operationHandler("listResourceTemplates"),
    "mcp-apps.readResource": operationHandler("readResource"),
    "mcp-apps.subscribeResource": operationHandler("subscribeResource"),
    "mcp-apps.unsubscribeResource": operationHandler("unsubscribeResource"),
  };

  return {
    capture,
    handlers,
    observeSource,
    closeSource(client: Client) {
      subscriptions.closeSource(client);
      if (catalogs.delete(client)) {
        client.removeNotificationHandler("notifications/tools/list_changed");
        client.removeNotificationHandler(
          "notifications/resources/list_changed",
        );
        client.removeNotificationHandler("notifications/resources/updated");
      }
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
