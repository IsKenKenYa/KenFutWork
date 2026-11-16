import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  JSONRPCMessageSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";

export const mcpAppCatalogSchema = z.object({
  tools: z.int().nonnegative().optional(),
  resources: z.int().nonnegative().optional(),
});
export type McpAppCatalogs = z.infer<typeof mcpAppCatalogSchema>;

export const mcpAppPageSchema = z.object({
  html: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: CallToolResultSchema,
  viewId: z.uuid(),
  serverTools: z.boolean(),
  serverResources: z.boolean().default(false),
  catalogs: mcpAppCatalogSchema,
});

// 中转文档是宿主代码；插件只进入第二层 iframe，不能拿到宿主 MessagePort。
const relay = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; base-uri 'none'; form-action 'none'">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style>
<script>
const receive = (event) => {
  if (event.source !== parent || event.data?.type !== 'kf:mcp-page' || !event.ports[0]) return;
  window.removeEventListener('message', receive);
  const port = event.ports[0];
  const view = document.createElement('iframe');
  view.setAttribute('sandbox', 'allow-scripts');
  view.setAttribute('referrerpolicy', 'no-referrer');
  view.title = 'MCP App';
  window.addEventListener('message', (packet) => {
    if (packet.source === view.contentWindow && packet.origin === 'null') port.postMessage(packet.data);
  });
  port.onmessage = (packet) => view.contentWindow?.postMessage(packet.data, '*');
  view.srcdoc = event.data.html;
  document.body.append(view);
};
window.addEventListener('message', receive);
parent.postMessage({ type: 'kf:mcp-page-ready' }, '*');
</script>`;

const documentPrefix = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'">`;

function portTransport(port: MessagePort): Transport {
  const transport: Transport = {
    async start() {
      port.onmessage = (event) => {
        const parsed = JSONRPCMessageSchema.safeParse(event.data);
        if (parsed.success) transport.onmessage?.(parsed.data);
      };
    },
    async send(message) {
      port.postMessage(message);
    },
    async close() {
      port.onmessage = null;
      port.close();
      transport.onclose?.();
    },
  };
  return transport;
}

function bindPageRequests(
  bridge: AppBridge,
  client: CodeHttpChannelClient,
  page: z.infer<typeof mcpAppPageSchema>,
  lifetime: AbortSignal,
) {
  const request = (
    method: Parameters<CodeHttpChannelClient["callMcpApp"]>[0],
    params: unknown,
    signal: AbortSignal,
  ) =>
    client.callMcpApp(
      method,
      [page.viewId, params],
      AbortSignal.any([signal, lifetime]),
    );
  if (page.serverTools) {
    bridge.setRequestHandler(ListToolsRequestSchema, async (message, extra) =>
      ListToolsResultSchema.parse(
        await request(
          "listTools",
          { cursor: message.params?.cursor },
          extra.signal,
        ),
      ),
    );
    bridge.oncalltool = async (params, extra) =>
      CallToolResultSchema.parse(
        await request(
          "callTool",
          {
            name: params.name,
            arguments: params.arguments,
            requestId: extra.requestId,
          },
          extra.signal,
        ),
      );
  }
  if (page.serverResources) {
    bridge.onlistresources = async (params, extra) =>
      ListResourcesResultSchema.parse(
        await request(
          "listResources",
          { cursor: params?.cursor },
          extra.signal,
        ),
      );
    bridge.onlistresourcetemplates = async (params, extra) =>
      ListResourceTemplatesResultSchema.parse(
        await request(
          "listResourceTemplates",
          { cursor: params?.cursor },
          extra.signal,
        ),
      );
    bridge.onreadresource = async (params, extra) =>
      ReadResourceResultSchema.parse(
        await request(
          "readResource",
          { uri: params.uri, requestId: extra.requestId },
          extra.signal,
        ),
      );
  }
}

export function McpAppFrame({
  client,
  page,
  catalogs,
  theme,
  onError,
  onClose,
}: {
  client: CodeHttpChannelClient;
  page: z.infer<typeof mcpAppPageSchema>;
  catalogs: McpAppCatalogs;
  theme: "light" | "dark";
  onError(): void;
  onClose(): void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const currentCatalogs = useRef(catalogs);
  const notifyCatalogs = useRef<((latest: McpAppCatalogs) => void) | null>(
    null,
  );
  useEffect(() => {
    currentCatalogs.current = catalogs;
    notifyCatalogs.current?.(catalogs);
  }, [catalogs]);

  useEffect(() => {
    const frame = iframe.current;
    if (!frame) return;
    const channel = new MessageChannel();
    const lifetime = new AbortController();
    const bridge = new AppBridge(
      null,
      { name: "KenFutWork", version: "1" },
      {
        ...(page.serverTools
          ? { serverTools: { listChanged: page.catalogs.tools !== undefined } }
          : {}),
        ...(page.serverResources
          ? {
              serverResources: {
                listChanged: page.catalogs.resources !== undefined,
              },
            }
          : {}),
      },
      {
        hostContext: {
          theme,
          locale: navigator.language,
          displayMode: "inline",
        },
      },
    );
    let closed = false;
    let transferred = false;
    bindPageRequests(bridge, client, page, lifetime.signal);
    bridge.addEventListener("sizechange", ({ height }) => {
      if (typeof height === "number" && Number.isFinite(height))
        setHeight(Math.max(56, Math.min(560, Math.ceil(height))));
    });
    bridge.addEventListener("requestteardown", onClose);
    bridge.addEventListener("initialized", () => {
      let previous = page.catalogs;
      void bridge
        .sendToolInput({ arguments: page.arguments })
        .then(() => bridge.sendToolResult(page.result))
        .then(() => {
          if (closed) return;
          notifyCatalogs.current = (latest) => {
            const changed: Array<Promise<void>> = [];
            if ((latest.tools ?? -1) > (previous.tools ?? -1))
              changed.push(bridge.sendToolListChanged());
            if ((latest.resources ?? -1) > (previous.resources ?? -1))
              changed.push(bridge.sendResourceListChanged());
            previous = latest;
            void Promise.all(changed).catch(() => {
              if (!closed) onError();
            });
          };
          notifyCatalogs.current(currentCatalogs.current);
        })
        .catch(() => {
          if (!closed) onError();
        });
    });
    const attach = (event: MessageEvent) => {
      const view = frame.contentWindow;
      if (
        !view ||
        event.source !== view ||
        event.origin !== "null" ||
        event.data?.type !== "kf:mcp-page-ready" ||
        transferred
      )
        return;
      transferred = true;
      void bridge
        .connect(portTransport(channel.port1))
        .then(() => {
          if (!closed)
            view.postMessage(
              { type: "kf:mcp-page", html: documentPrefix + page.html },
              "*",
              [channel.port2],
            );
        })
        .catch(() => {
          if (!closed) onError();
        });
    };
    window.addEventListener("message", attach);
    frame.srcdoc = relay;
    return () => {
      closed = true;
      notifyCatalogs.current = null;
      lifetime.abort();
      window.removeEventListener("message", attach);
      channel.port1.close();
      if (!transferred) channel.port2.close();
      void bridge.close();
    };
  }, [client, page, theme, onError, onClose]);

  return (
    <iframe
      ref={iframe}
      title="插件页面"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height }}
      className="w-full rounded-md border border-border bg-surface"
    />
  );
}
