import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { RequestIdSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import {
  executeApprovedMcpAppOperation,
  type McpAppExecution,
  type McpAppSource,
} from "./mcp-app-approval.js";

const uriSchema = z.string().refine((uri) => URL.canParse(uri));
const resourceRequestSchema = z
  .object({ uri: uriSchema, requestId: RequestIdSchema })
  .strict();
const unsubscribeSchema = z.object({ uri: uriSchema }).strict();

function resourceApproval(
  input: McpAppExecution,
  uri: string,
  subscribe: boolean,
) {
  const { serverName } = input.authorization;
  const displayUri = new URL(uri);
  displayUri.username = "";
  displayUri.password = "";
  displayUri.search = "";
  displayUri.hash = "";
  const toolName = subscribe ? "subscribe_resource" : "read_resource";
  return {
    toolName: `mcp__${serverName}__${toolName}`,
    summary: subscribe ? "插件页面请求订阅资源" : "插件页面请求读取资源",
    args: { uri },
    displayArgs: {
      uri: displayUri.href.startsWith(`${displayUri.protocol}//`)
        ? displayUri.href
        : displayUri.protocol,
    },
    display: { kind: "mcp_tool" as const, serverName, toolName },
  };
}

export function readMcpAppResource(input: McpAppExecution, requested: unknown) {
  const { uri, requestId } = resourceRequestSchema.parse(requested);
  return executeApprovedMcpAppOperation(input, {
    ...resourceApproval(input, uri, false),
    requestId,
    // URI 只交给原 MCP 服务，不交给本机文件系统或网络请求。
    execute: (options) => input.source.client.readResource({ uri }, options),
  });
}

/** 同连接、同 URI 共用远端订阅；每个页面独立取得 Task 授权。 */
export function createMcpAppSubscriptions(wake: (viewId: string) => void) {
  type Resource = {
    source: McpAppSource;
    owners: Map<string, number>;
    active: boolean;
    uncertain: boolean;
    disposed: boolean;
    tail: Promise<unknown>;
  };
  type Subscription = {
    abort: AbortController;
    ready: Promise<Record<string, never>>;
    resource?: Resource;
  };
  const sources = new WeakMap<Client, Map<string, Resource>>();
  const views = new Map<string, Map<string, Subscription>>();
  let revision = 0;

  function synchronize(uri: string, resource: Resource, signal?: AbortSignal) {
    const update = async () => {
      const { source, owners } = resource;
      if (resource.disposed || !source.current()) return;
      const shouldSubscribe = owners.size > 0;
      if (resource.active === shouldSubscribe && !resource.uncertain) return;
      const options = await source.options(
        resource.uncertain
          ? new AbortController().signal
          : (signal ?? new AbortController().signal),
      );
      if (resource.disposed || !source.current()) return;
      // 取消发生在远端接收之后时，先清理结果未知的订阅。
      if (resource.uncertain || !owners.size) {
        await source.client.unsubscribeResource({ uri }, options);
        resource.active = false;
        resource.uncertain = false;
      }
      if (owners.size && !resource.active) {
        try {
          await source.client.subscribeResource(
            { uri },
            await source.options(signal ?? new AbortController().signal),
          );
          resource.active = true;
        } catch (error) {
          resource.uncertain = true;
          throw error;
        }
      }
    };
    // 前一次失败仍由原调用方接收；下一次操作按当前所有者重新核对。
    const run = resource.tail.then(update, update);
    resource.tail = run;
    return run;
  }

  async function release(
    viewId: string,
    uri: string,
    subscription: Subscription,
  ) {
    const owned = views.get(viewId);
    if (owned?.get(uri) === subscription) {
      owned.delete(uri);
      if (!owned.size) views.delete(viewId);
    }
    subscription.abort.abort();
    const resource = subscription.resource;
    delete subscription.resource;
    if (!resource?.owners.delete(viewId)) return;
    wake(viewId);
    const pending = synchronize(uri, resource);
    await pending;
    if (!resource.active && !resource.owners.size && resource.tail === pending)
      sources.get(resource.source.client)?.delete(uri);
  }

  function subscribe(input: McpAppExecution, requested: unknown) {
    const { uri, requestId } = resourceRequestSchema.parse(requested);
    if (!input.source.client.getServerCapabilities()?.resources?.subscribe)
      throw new CodeUiHostRpcError(
        "mcp_app_operation_unavailable",
        "此服务不支持资源订阅。",
        403,
      );
    const owned = views.get(input.viewId) ?? new Map<string, Subscription>();
    const current = owned.get(uri);
    if (current) return current.ready;
    const abort = new AbortController();
    const execution = {
      ...input,
      signal: AbortSignal.any([input.signal, abort.signal]),
    };
    const subscription: Subscription = {
      abort,
      ready: Promise.resolve({}),
    };
    owned.set(uri, subscription);
    views.set(input.viewId, owned);
    subscription.ready = executeApprovedMcpAppOperation(execution, {
      ...resourceApproval(input, uri, true),
      requestId,
      async execute() {
        execution.signal.throwIfAborted();
        const resources =
          sources.get(input.source.client) ?? new Map<string, Resource>();
        sources.set(input.source.client, resources);
        let resource = resources.get(uri);
        if (!resource) {
          resource = {
            source: input.source,
            owners: new Map(),
            active: false,
            uncertain: false,
            disposed: false,
            tail: Promise.resolve(),
          };
          resources.set(uri, resource);
        }
        subscription.resource = resource;
        resource.owners.set(input.viewId, 0);
        wake(input.viewId);
        await synchronize(uri, resource, execution.signal);
        return {};
      },
    }).catch(async (error) => {
      await release(input.viewId, uri, subscription);
      throw error;
    });
    return subscription.ready;
  }

  return {
    subscribe,
    async unsubscribe(viewId: string, requested: unknown) {
      const { uri } = unsubscribeSchema.parse(requested);
      const subscription = views.get(viewId)?.get(uri);
      if (subscription) await release(viewId, uri, subscription);
      return {};
    },
    versions(viewId: string) {
      const subscriptions: Record<string, number> = {};
      for (const [uri, subscription] of views.get(viewId) ?? []) {
        const version = subscription.resource?.owners.get(viewId);
        if (version !== undefined) subscriptions[uri] = version;
      }
      return Object.keys(subscriptions).length ? { subscriptions } : {};
    },
    updated(client: Client, uri: string) {
      const resource = sources.get(client)?.get(uri);
      if (!resource) return;
      revision += 1;
      for (const viewId of resource.owners.keys()) {
        resource.owners.set(viewId, revision);
        wake(viewId);
      }
    },
    async closeView(viewId: string) {
      await Promise.all(
        [...(views.get(viewId) ?? [])].map(([uri, subscription]) =>
          release(viewId, uri, subscription),
        ),
      );
    },
    closeSource(client: Client) {
      for (const resource of sources.get(client)?.values() ?? []) {
        resource.disposed = true;
        resource.owners.clear();
      }
      sources.delete(client);
    },
  };
}
