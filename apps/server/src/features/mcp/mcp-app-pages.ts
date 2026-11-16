import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import {
  type CodeUiHostRpcContext,
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import type { LocalActor } from "../local-instance/types.js";
import { type McpServerToolLike, mcpAppResourceUri, mcpAppView } from "./mcp-tools.js";

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

type PageSource = {
  client: Client;
  current(): boolean;
  read(uri: string, signal: AbortSignal): ReturnType<Client["readResource"]>;
};

export function createMcpAppPages() {
  type Entry = {
    source: PageSource;
    uri: string;
    toolCallId: string;
    handle: NonNullable<ToolExecutionContext["scopeHandle"]>;
    scope: ReturnType<
      NonNullable<ToolExecutionContext["scopeHandle"]>["describe"]
    >;
    payload: string;
    bytes: number;
    invalidated: AbortController;
  };
  const pages = new Map<string, Entry>();
  let bytes = 0;

  function remove(ref: string, entry: Entry) {
    if (!pages.delete(ref)) return;
    bytes -= entry.bytes;
    entry.invalidated.abort();
  }

  function capture(input: {
    source: PageSource;
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
    });
    bytes += size;
    return { ...result, [mcpAppView]: { ref, serverName, toolName: tool.name } };
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
    signal: AbortSignal,
  ) {
    const entry = await requirePage(actor, requested, signal);
    const readSignal = AbortSignal.any([signal, entry.invalidated.signal]);
    const response = await entry.source.read(entry.uri, readSignal).catch(() => {
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
    return { html: document.text, ...JSON.parse(entry.payload) };
  }

  const requestSignal = (context: CodeUiHostRpcContext) =>
    context.requestSignal
      ? AbortSignal.any([context.requestSignal, context.signal])
      : context.signal;
  const handlers: Record<string, CodeUiHostRpcHandler> = {
    "mcp-apps.open": {
      call(actor, args, context) {
        return runCodeUiHostRpc(context, () =>
          open(actor, args[0], requestSignal(context)),
        );
      },
    },
    "mcp-apps.waitForClose": {
      call(actor, args, context) {
        return runCodeUiHostRpc(context, async () => {
          const request = requestSignal(context);
          const entry = await requirePage(actor, args[0], request);
          const signal = AbortSignal.any([entry.invalidated.signal, request]);
          if (!signal.aborted)
            await new Promise<void>((resolve) => {
              const listener = addAbortListener(signal, () => {
                listener[Symbol.dispose]();
                resolve();
              });
            });
          return null;
        });
      },
    },
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
        if (entry.scope.instanceId === instanceId && entry.scope.taskId === taskId)
          remove(ref, entry);
    },
  };
}

export type McpAppPages = ReturnType<typeof createMcpAppPages>;
