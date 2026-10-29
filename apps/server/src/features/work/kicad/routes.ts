import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../../local-access/types.js";
import { KicadWorker } from "./worker.js";

/**
 * KiCad 面板的宿主桥（MCP Apps）。
 *
 * 上游面板是 `ui://kicad/board.html` 资源，通过 postMessage 的 JSON-RPC 与宿主通信
 * （`ui/initialize`、`tools/call`、`resources/read`、尺寸/显示模式通知）。这里提供
 * 一层同源包装页：iframe 里面是原面板，外面这层实现宿主侧协议并把调用转发到同一个
 * MCP 服务进程（agent 与面板看到同一份产物）。
 */

const PANEL_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KiCad 电路板</title>
<style>
html,body{margin:0;height:100%;background:#fff;display:flex;flex-direction:column}
#hint{display:none;flex:0 0 auto;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid #e5e1da;background:#fbfaf8;font:12px/1.4 system-ui,sans-serif;color:#6b7280}
#hint[data-on="1"]{display:flex}
#hint b{font-weight:600;color:#1f2328}
#hint code{font:11px/1.4 ui-monospace,Consolas,monospace;color:#1f2328;background:#fff;border:1px solid #e5e1da;border-radius:6px;padding:2px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hint-retry{margin-left:auto;font:12px/1 system-ui,sans-serif;color:#1f2328;background:#fff;border:1px solid #e5e1da;border-radius:6px;padding:5px 10px;cursor:pointer}
#hint-retry:hover{border-color:#c9c4ba}
iframe{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;height:100%}
</style>
</head>
<body>
<div id="hint" role="status"><b>未检测到 KiCad 10</b><span>安装到</span><code id="hint-path"></code><button id="hint-retry" type="button">重新检测</button></div>
<iframe id="panel" src="/api/work/host/kicad/panel.html" title="KiCad 电路板"></iframe>
<script>
(function () {
  var frame = document.getElementById("panel");
  var STATE = { displayMode: "fullscreen" };
  function post(message) {
    try { frame.contentWindow.postMessage(message, window.location.origin); } catch (error) {}
  }
  function ok(id, result) { post({ jsonrpc: "2.0", id: id, result: result }); }
  function fail(id, message) { post({ jsonrpc: "2.0", id: id, error: { code: -32000, message: String(message) } }); }
  function rpc(method, params) {
    return fetch("/api/work/host/kicad/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: method, params: params || {} }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body && body.error ? body.error.message : "调用失败");
        return body.result;
      });
    });
  }
  async function handle(message) {
    switch (message.method) {
      case "ui/initialize":
        return {
          protocolVersion: "2025-06-18",
          hostInfo: { name: "KenFutWork", version: "1.0.0" },
          hostCapabilities: { tools: { listChanged: false }, resources: {}, logging: {} },
          hostContext: {
            theme: "light",
            displayMode: STATE.displayMode,
            availableDisplayModes: ["inline", "fullscreen"],
            containerDimensions: { maxHeight: 4000, width: window.innerWidth },
            platform: "desktop",
          },
        };
      case "tools/call":
        return await rpc("tools/call", {
          name: message.params && message.params.name,
          arguments: (message.params && message.params.arguments) || {},
        });
      case "resources/read":
        return await rpc("resources/read", { uri: message.params && message.params.uri });
      case "ping":
        return {};
      case "logging/setLevel":
        return {};
      case "ui/open-link": {
        var url = message.params && message.params.url;
        if (typeof url === "string" && /^https?:/u.test(url)) window.open(url, "_blank", "noopener");
        return {};
      }
      case "ui/request-display-mode": {
        var mode = message.params && message.params.mode;
        STATE.displayMode = mode === "inline" ? "inline" : "fullscreen";
        post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: STATE.displayMode } });
        return { displayMode: STATE.displayMode };
      }
      case "ui/update-model-context":
        return {};
      case "ui/message":
        return {};
      default:
        return {};
    }
  }
  async function hint() {
    try {
      var status = await fetch("/api/work/host/kicad/status").then(function (r) { return r.json(); });
      var bar = document.getElementById("hint");
      if (status.kicadInstalled) {
        // 装好之后刷新一次：面板需要在服务重新识别到 KiCad 后重跑首屏。
        if (bar.dataset.on === "1") window.location.reload();
        else bar.dataset.on = "0";
        return;
      }
      document.getElementById("hint-path").textContent =
        status.kicadInstallHint || status.kicadApp || "";
      bar.dataset.on = "1";
    } catch (error) {}
  }
  hint();
  document.getElementById("hint-retry").addEventListener("click", hint);
  async function prime() {
    try {
      var result = await rpc("tools/call", { name: "kicad_board_view", arguments: { side: "top" } });
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { side: "top" } } });
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
    } catch (error) {}
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) return;
    if (event.source !== frame.contentWindow) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/initialized") { prime(); return; }
    if (message.method === "ui/notifications/size-changed") return;
    if (message.id === undefined) return;
    handle(message).then(function (result) { ok(message.id, result); }, function (error) { fail(message.id, error && error.message ? error.message : error); });
  });
})();
</script>
</body>
</html>`;

export function registerKicadRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    worker: KicadWorker;
  },
): void {
  const panelFile = join(KicadWorker.pluginRoot(), "dist", "panel.html");
  let panelCache: string | null = null;
  const requireLocalAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await options.localAccess.authenticate(request)) return true;
    reply.code(401).send({
      error: { code: "unauthorized", message: "本机接入凭据缺失或无效。" },
    });
    return false;
  };

  app.get("/api/work/host/kicad/status", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    options.worker.ensureStarted();
    return reply.send(await options.worker.status());
  });

  app.get("/api/work/host/kicad/panel", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    options.worker.ensureStarted();
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-cache")
      .send(PANEL_PAGE);
  });

  app.get("/api/work/host/kicad/panel.html", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    panelCache ??= readFileSync(panelFile, "utf8");
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-cache")
      .send(panelCache);
  });

  app.post("/api/work/host/kicad/rpc", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body = (request.body ?? {}) as {
      method?: unknown;
      params?: unknown;
    };
    const method = typeof body.method === "string" ? body.method : "";
    const params = (body.params ?? {}) as Record<string, unknown>;
    try {
      if (method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : "";
        if (!name) {
          return reply
            .code(400)
            .send({ error: { code: "invalid_input", message: "缺少工具名。" } });
        }
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        return reply.send({ result: await options.worker.callTool(name, args) });
      }
      if (method === "resources/read") {
        const uri = typeof params.uri === "string" ? params.uri : "";
        return reply.send({ result: await options.worker.readResource(uri) });
      }
      if (method === "tools/list") {
        return reply.send({ result: { tools: await options.worker.listTools() } });
      }
      return reply
        .code(400)
        .send({ error: { code: "invalid_input", message: "不支持的方法。" } });
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "kicad_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}
