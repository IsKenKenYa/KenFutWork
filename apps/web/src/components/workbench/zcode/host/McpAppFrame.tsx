import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

export const mcpAppPageSchema = z.object({
  html: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: CallToolResultSchema,
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

export function McpAppFrame({
  page,
  theme,
  onError,
  onClose,
}: {
  page: z.infer<typeof mcpAppPageSchema>;
  theme: "light" | "dark";
  onError(): void;
  onClose(): void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);

  useEffect(() => {
    const frame = iframe.current;
    if (!frame) return;
    const channel = new MessageChannel();
    const bridge = new AppBridge(
      null,
      { name: "KenFutWork", version: "1" },
      {},
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
    bridge.addEventListener("sizechange", ({ height }) => {
      if (typeof height === "number" && Number.isFinite(height))
        setHeight(Math.max(56, Math.min(560, Math.ceil(height))));
    });
    bridge.addEventListener("requestteardown", onClose);
    bridge.addEventListener("initialized", () => {
      void bridge
        .sendToolInput({ arguments: page.arguments })
        .then(() => bridge.sendToolResult(page.result))
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
      window.removeEventListener("message", attach);
      channel.port1.close();
      if (!transferred) channel.port2.close();
      void bridge.close();
    };
  }, [page, theme, onError, onClose]);

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
