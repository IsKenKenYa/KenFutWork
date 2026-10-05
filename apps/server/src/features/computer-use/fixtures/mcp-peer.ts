/** 外部协议测试peer：真实stdio进程，故意返回错误wire元数据；不宣称控制过桌面。 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";

const mode = process.argv[2];
const server = new Server(
  { name: "desktop-protocol-fixture", version: "test" },
  {
    capabilities: {
      tools: {},
      logging: {},
      experimental: { "kenfutwork.computer-use": { version: 1 } },
    },
  },
);
const node = (index: number, depth: number) => ({
  index,
  depth,
  node: { role: "group", title: `node-${index}` },
});
let actionStarted = false;
server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
  let structuredContent: Record<string, unknown>;
  if (mode === "bad-permissions") {
    structuredContent = {
      permissionStatus: { accessibility: "maybe", screen: "granted" },
      hint: "protocol fixture",
    };
  } else if (mode === "bad-apps") {
    structuredContent = {
      apps: [{ pid: -1, name: "peer", bundleId: null, active: true }],
    };
  } else if (
    mode === "bad-frame" ||
    mode === "pixel-budget" ||
    mode === "valid-frame"
  ) {
    const size = mode === "pixel-budget" ? 128 : 2;
    const png = new PNG({ width: size, height: size });
    png.data.fill(255);
    return {
      content: [
        {
          type: "image" as const,
          mimeType: "image/png",
          data: PNG.sync.write(png).toString("base64"),
        },
      ],
      structuredContent: {
        image: {
          frameId: "peer-frame",
          mimeType: "image/png",
          width: mode === "bad-frame" ? 3 : size,
          height: size,
          bounds: [0, 0, size, size],
        },
      },
    };
  } else if (mode === "action-false" || mode === "action-invalid") {
    structuredContent = {
      actionSent: mode === "action-false" ? false : "true",
    };
  } else if (
    mode === "wait-cancel" ||
    (mode === "cancel-lifecycle" &&
      _request.params.name === "click" &&
      !actionStarted)
  ) {
    actionStarted = true;
    await server.sendLoggingMessage({ level: "info", data: "request-started" });
    await new Promise<void>((resolve) => {
      extra.signal.addEventListener("abort", () => resolve(), { once: true });
      if (extra.signal.aborted) resolve();
    });
    await server.sendLoggingMessage({
      level: "info",
      data: "request-cancelled",
    });
    structuredContent = { actionSent: false };
  } else if (
    (mode === "lifecycle" || mode === "cancel-lifecycle") &&
    _request.params.name !== "get_app_state"
  ) {
    structuredContent = { actionSent: true };
  } else {
    const elements =
      mode === "tree-gap"
        ? [node(10, 0), node(50, 2)]
        : mode === "tree-duplicates"
          ? [node(10, 0), node(10, 1)]
          : [node(10, 0), node(50, 1), node(80, 2), node(1000, 1)];
    structuredContent = {
      app: { pid: null, name: "protocol peer", bundle_id: null },
      window: { window_id: 9, title: "wire fixture", bounds: [0, 0, 2, 2] },
      elements,
    };
  }
  return {
    content: [{ type: "text" as const, text: "外部wire fixture，无桌面动作" }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());
