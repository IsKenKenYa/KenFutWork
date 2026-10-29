import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
#bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #e5e1da;background:#fff;font:12px/1.4 system-ui,sans-serif;color:#6b7280}
#bar button,#bar label{font:12px/1 system-ui,sans-serif;color:#1f2328;background:#fff;border:1px solid #e5e1da;border-radius:6px;padding:5px 10px;cursor:pointer}
#bar button:hover,#bar label:hover{border-color:#c9c4ba}
#bar button:disabled{opacity:.5;cursor:default}
#bar-status{color:#1f2328}
#bar-status[data-bad="1"]{color:#c0392b}
iframe{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;height:100%}
</style>
</head>
<body>
<div id="bar"><label class="open" for="bar-file">打开文件</label><input id="bar-file" type="file" accept=".kicad_pcb,.json,application/json" hidden><button id="bar-example" type="button">示例板</button><span id="bar-status"></span></div>
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
      // 引擎重启/代理兜底时回的是纯文本，直接 JSON.parse 会把 "Unexpected token 'I'…" 甩到面板上。
      return response.text().then(function (raw) {
        var body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (error) {}
        if (!body) throw new Error("KiCad 引擎未就绪，请稍后重试");
        if (!response.ok) throw new Error((body.error && body.error.message) || "KiCad 引擎未就绪，请稍后重试");
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
            locale: "zh-CN",
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
  var barStatus = document.getElementById("bar-status");
  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.text().then(function (raw) {
        try {
          return JSON.parse(raw);
        } catch (error) {
          return { ok: false, error: "KiCad 引擎未就绪，请稍后重试" };
        }
      });
    });
  }
  function setBusy(on, text) {
    document.getElementById("bar-example").disabled = on;
    if (text) barStatus.textContent = text;
    barStatus.dataset.bad = "0";
  }
  function report(data) {
    if (data && data.ok) {
      barStatus.textContent = data.unconnected
        ? "DRC " + data.errors + " 错误 · " + data.unconnected + " 未连接"
        : "DRC " + data.errors + " 错误";
      barStatus.dataset.bad = data.errors || data.unconnected ? "1" : "0";
      frame.src = "/api/work/host/kicad/panel.html?t=" + Date.now();
    } else {
      barStatus.textContent = (data && data.error) || "构建失败";
      barStatus.dataset.bad = "1";
    }
  }
  async function build(kind, body) {
    setBusy(true, "构建中…");
    try {
      var response = await fetch("/api/work/host/kicad/" + kind, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      report(await response.json());
    } catch (error) {
      report({ ok: false, error: String(error) });
    } finally {
      setBusy(false);
    }
  }
  document.getElementById("bar-example").addEventListener("click", function () { build("example", {}); });
  async function upload(body) {
    setBusy(true, "打开中…");
    try {
      var response = await fetch("/api/work/host/kicad/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      report(await response.json());
    } catch (error) {
      report({ ok: false, error: String(error) });
    } finally {
      setBusy(false);
    }
  }
  document.getElementById("bar-file").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    var reader = new FileReader();
    var board = /\.kicad_pcb$/i.test(file.name);
    reader.onload = function () {
      var result = String(reader.result);
      upload(
        board
          ? { name: file.name, base64: result.slice(result.indexOf(",") + 1) }
          : { name: file.name, text: result },
      );
    };
    if (board) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
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

  // 面板工具条：从示例或用户上传的 spec 直接建板（跑完 pcb_check_spec + pcb_build）。
  const build = async (reply: FastifyReply, specPath?: string, spec?: unknown) => {
    const { worker } = options;
    const checked = specPath
      ? await worker.callTool("kicad_check_spec_file", { spec_path: specPath })
      : await worker.callTool("pcb_check_spec", { spec });
    const check = checked.structuredContent as
      | { ok?: boolean; error?: string; spec_artifact_id?: string }
      | undefined;
    if (!check?.ok || !check.spec_artifact_id) {
      return reply.send({
        ok: false,
        error: check?.error ?? "spec 校验失败",
      });
    }
    const built = await worker.callTool("pcb_build", {
      spec_artifact_id: check.spec_artifact_id,
      route: true,
    });
    const board = built.structuredContent as
      | {
          ok?: boolean;
          error?: string;
          pcb_artifact_id?: string;
          drc?: { errors?: number; unconnected?: number };
        }
      | undefined;
    return reply.send({
      ok: Boolean(board?.ok),
      error: board?.error ?? null,
      artifact_id: board?.pcb_artifact_id ?? null,
      errors: board?.drc?.errors ?? 0,
      unconnected: board?.drc?.unconnected ?? 0,
    });
  };

  app.post("/api/work/host/kicad/example", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    try {
      const example = await options.worker.callTool("pcb_spec_example", {
        name: "ne555_blinker",
        inline: true,
      });
      const spec = (example.structuredContent as { spec?: unknown } | undefined)
        ?.spec;
      if (!spec) {
        return reply
          .code(502)
          .send({ ok: false, error: "示例电路 spec 缺失。" });
      }
      return await build(reply, undefined, spec);
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/work/host/kicad/spec", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body = (request.body ?? {}) as { text?: unknown; name?: unknown };
    if (typeof body.text !== "string") {
      return reply.code(400).send({ ok: false, error: "缺少 spec 内容。" });
    }
    let parsed: { parts?: unknown };
    try {
      parsed = JSON.parse(body.text) as { parts?: unknown };
    } catch {
      return reply.code(400).send({ ok: false, error: "这不是 JSON 文件。" });
    }
    if (!Array.isArray(parsed.parts)) {
      return reply
        .code(400)
        .send({ ok: false, error: "spec 缺少 parts 数组。" });
    }
    const rawName = typeof body.name === "string" ? body.name : "board";
    const name = /^[\w.-]{1,40}$/u.test(rawName) ? rawName : "board";
    const dir = join(options.worker.workspaceDir(), "kicad");
    const specPath = join(dir, `${name}_spec.json`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(specPath, body.text, "utf8");
      return await build(reply, specPath);
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 面板的「打开文件」：spec JSON 走建板流程，已有 .kicad_pcb 直接作为当前板打开。
  app.post(
    "/api/work/host/kicad/file",
    { bodyLimit: 48 * 1024 * 1024 },
    async (request, reply) => {
      if (!(await requireLocalAccess(request, reply))) return;
      const body = (request.body ?? {}) as {
        name?: unknown;
        text?: unknown;
        base64?: unknown;
      };
      const rawName = typeof body.name === "string" ? body.name : "";
      const name = /^[\w.-]{1,60}$/u.test(rawName) ? rawName : "";
      if (!name) {
        return reply.code(400).send({ ok: false, error: "文件名不合法。" });
      }
      const stem = name.replace(/\.[^.]+$/u, "");
      const ext = name.slice(stem.length).toLowerCase();
      const dir = join(options.worker.workspaceDir(), "kicad", "open");
      if (ext === ".json") {
        if (typeof body.text !== "string") {
          return reply.code(400).send({ ok: false, error: "缺少 spec 内容。" });
        }
        let parsed: { parts?: unknown };
        try {
          parsed = JSON.parse(body.text) as { parts?: unknown };
        } catch {
          return reply
            .code(400)
            .send({ ok: false, error: "这不是 JSON 文件。" });
        }
        if (!Array.isArray(parsed.parts)) {
          return reply
            .code(400)
            .send({ ok: false, error: "spec 缺少 parts 数组。" });
        }
        try {
          mkdirSync(dir, { recursive: true });
          const specPath = join(dir, `${stem}_spec.json`);
          writeFileSync(specPath, body.text, "utf8");
          return await build(reply, specPath);
        } catch (error) {
          return reply.code(502).send({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (ext === ".kicad_pcb") {
        if (typeof body.base64 !== "string") {
          return reply.code(400).send({ ok: false, error: "缺少板文件内容。" });
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(body.base64, "base64");
        } catch {
          return reply.code(400).send({ ok: false, error: "板文件编码不合法。" });
        }
        if (bytes.length === 0) {
          return reply.code(400).send({ ok: false, error: "板文件是空的。" });
        }
        try {
          mkdirSync(dir, { recursive: true });
          const boardPath = join(dir, `${stem}.kicad_pcb`);
          writeFileSync(boardPath, bytes);
          const imported = await options.worker.callTool("kicad_import_board", {
            board_path: boardPath,
            name: stem,
          });
          const summary = imported.structuredContent as
            | {
                ok?: boolean;
                error?: string;
                artifact_id?: string;
                errors?: number;
                unconnected?: number;
                drc_passed?: boolean | null;
              }
            | undefined;
          return reply.send({
            ok: Boolean(summary?.ok),
            error: summary?.error ?? null,
            artifact_id: summary?.artifact_id ?? null,
            errors: summary?.errors ?? 0,
            unconnected: summary?.unconnected ?? 0,
          });
        } catch (error) {
          return reply.code(502).send({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return reply
        .code(400)
        .send({ ok: false, error: "只支持 .kicad_pcb 与 spec JSON。" });
    },
  );

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
