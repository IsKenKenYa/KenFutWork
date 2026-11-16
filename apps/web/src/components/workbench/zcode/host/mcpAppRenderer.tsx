import type { ToolCallRendererContribution } from "@zui/ToolCallBlocks/contributedRenderers.js";
import { McpToolCallBlock } from "@zui/ToolCallBlocks/renderers/mcp.js";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";
import { Button } from "@zui/components/ui/button.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { McpAppFrame, mcpAppPageSchema } from "./McpAppFrame.js";

function readRef(context: ToolCallBlockRenderContext): string | undefined {
  const { status, raw } = context.toolCallNode.toolCall;
  if (context.isPermissionPreview || status !== "completed" || !raw ||
      typeof raw !== "object" || !("display" in raw)) return undefined;
  const display = raw.display;
  if (!display || typeof display !== "object" || !("kind" in display) ||
      display.kind !== "mcp_tool" || !("appRef" in display)) return undefined;
  return typeof display.appRef === "string" ? display.appRef : undefined;
}

function McpAppView({ client, refId, toolCallId, theme }: {
  client: CodeHttpChannelClient;
  refId: string;
  toolCallId: string;
  theme: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<z.infer<typeof mcpAppPageSchema> | null>(null);
  const control = useRef<HTMLButtonElement>(null);
  const target = useMemo(() => ({ ref: refId, toolCallId }), [refId, toolCallId]);
  const close = useCallback(() => {
    setOpen(false);
    setPage(null);
    control.current?.focus();
  }, []);
  const failed = useCallback(() => {
    close();
    setError("插件页面加载失败");
  }, [close]);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    void (async () => {
      try {
        const received = await client.callMcpApp("open", target, request.signal);
        if (request.signal.aborted) return;
        setPage(mcpAppPageSchema.parse(received));
        await client.callMcpApp("waitForClose", target, request.signal);
        if (!request.signal.aborted) {
          close();
          setError("页面已失效，请重新运行工具");
        }
      } catch {
        if (!request.signal.aborted) failed();
      }
    })();
    return () => request.abort();
  }, [open, target, client, close, failed]);
  return (
    <div className="grid min-w-0 gap-2 px-2 py-1">
      <Button ref={control} size="sm" variant="outline" className="justify-self-start" aria-expanded={open}
        onClick={() => {
          if (open) close();
          else { setError(null); setOpen(true); }
        }}>
        {open ? "关闭插件页面" : "打开插件页面"}
      </Button>
      {open && !page ? <p role="status" className="text-xs text-foreground-subtle">读取插件页面…</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {open && page ? <McpAppFrame page={page} theme={theme} onError={failed} onClose={close} /> : null}
    </div>
  );
}

export function createMcpAppRenderer(client: CodeHttpChannelClient): ToolCallRendererContribution {
  return {
    id: "host.mcp-app",
    matches: (context) => readRef(context) !== undefined,
    component: function McpAppToolCall(context) {
      const ref = readRef(context);
      const toolCallId = context.toolCallNode.toolCall.toolId;
      const dark = context.theme === "dark" ||
        (context.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      return <>
        <McpToolCallBlock {...context} />
        {ref ? <McpAppView key={`${toolCallId}:${ref}`} client={client} refId={ref}
          toolCallId={toolCallId} theme={dark ? "dark" : "light"} /> : null}
      </>;
    },
  };
}
