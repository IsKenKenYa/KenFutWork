import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildApp } from "../apps/server/src/app.js";
import {
  clickOn,
  connectCdpClient,
  findBrowserExecutable,
  launchBrowserWithDebugPort,
  pressKey,
  waitForDevtools,
} from "../apps/server/src/features/browser/cdp-client.js";
import { createTaskWorkDatabase } from "../apps/server/src/features/task-work/test-postgres-schema.js";

const webDist = fileURLToPath(new URL("../apps/web/out", import.meta.url));
// 这个验收使用刚构建的静态客户端和独立数据库，不接触开发实例。
await access(join(webDist, "canvas.html"));
const executable = findBrowserExecutable();
assert(executable, "未找到 Chrome 或 Chromium");
const db = await createTaskWorkDatabase();
let app: ReturnType<typeof buildApp> | undefined;
let chrome: Awaited<ReturnType<typeof launchBrowserWithDebugPort>> | undefined;
let cdp: ReturnType<typeof connectCdpClient> | undefined;

async function until<T>(description: string, read: () => Promise<T | false>) {
  const expires = Date.now() + 25_000;
  while (Date.now() < expires) {
    const value = await read();
    if (value !== false) return value;
    await delay(100);
  }
  throw new Error(`等待${description}超时`);
}

try {
  app = buildApp({
    env: {
      databaseUrl: db.connectionString,
      desktopDataDir: db.directory,
      queueDriver: "in-process",
      pluginsDir: join(db.directory, "plugins"),
      agentFilesRoot: join(db.directory, "agent-files"),
      blobDir: join(db.directory, "blobs"),
      sandboxRoot: join(db.directory, "sandbox"),
      checkpointRoot: join(db.directory, "checkpoints"),
      // 本验收使用内置画布，不启动 OpenDesign 伴随容器。
      openDesignFrontendUrl: "http://127.0.0.1:1",
      webOrigin: "http://127.0.0.1",
      serverHost: "127.0.0.1",
      webDist,
    },
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const token = await app.kernel.get("localAccess").getDesktopToken();
  async function post<T>(path: string, body: object): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert(response.ok, `${path} HTTP ${response.status}`);
    return response.json();
  }
  const { project } = await post<{ project: { id: string } }>("/api/projects", {
    name: "窄屏画布验收",
    kind: "design",
  });
  const { canvas } = await post<{ canvas: { id: string; name: string } }>(
    `/api/projects/${project.id}/canvases`,
    { name: "窄屏画板" },
  );
  const { ticket } = await post<{ ticket: string }>("/api/local-access/tickets", {});
  const profileDir = join(db.directory, "design-viewport-chrome");
  chrome = await launchBrowserWithDebugPort({ executable, port: 0, profileDir, headless: true });
  const port = await until("独立 Chrome 就绪", async () => {
    const active = await readFile(join(profileDir, "DevToolsActivePort"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    return Number(active.split("\n")[0]) || false;
  });
  const client = connectCdpClient((await waitForDevtools(port)).webSocketDebuggerUrl);
  cdp = client;
  const { sessionId } = await client.openTab("about:blank");
  const send = (method: string, params: Record<string, unknown> = {}) =>
    client.send(method, params, sessionId);
  const resize = (width: number) => send("Emulation.setDeviceMetricsOverride", {
    width, height: 820, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await resize(390);
  const url = new URL("/workbench", origin);
  url.search = new URLSearchParams({ mode: "design", projectId: project.id, canvasId: canvas.id }).toString();
  url.hash = new URLSearchParams({ connect: ticket }).toString();
  await send("Page.navigate", { url: url.href });

  async function inWorkbench<T>(body: string) {
    const expression = `(() => {
      const code = document.querySelector('iframe[src*="/code-ui/"]');
      const shell = code?.contentDocument;
      const editor = shell?.querySelector('iframe[src*="/canvas"]');
      const doc = editor?.contentDocument;
      const visible = el => el?.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const label = el => el?.getAttribute('aria-label') || el?.title || el?.innerText;
      const zoom = () => [...doc.querySelectorAll('button')].filter(visible).map(label).find(value => /^\\d+%$/.test(value));
      ${body}
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true }) as {
      exceptionDetails?: unknown;
      result: { value: T };
    };
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function click(locator: string, inEditor = false) {
    const point = await inWorkbench<{ x: number; y: number } | null>(`
      const el = ${inEditor
        ? `[...doc.querySelectorAll('button, label')].find(node => visible(node) && label(node) === ${JSON.stringify(locator)})`
        : `shell.querySelector(${JSON.stringify(locator)})`};
      if (!visible(el)) return null;
      const rects = [code, el, ${inEditor ? "editor" : "null"}].filter(Boolean).map(node => node.getBoundingClientRect());
      return { x: rects.reduce((sum, rect) => sum + rect.left, rects[1].width / 2),
        y: rects.reduce((sum, rect) => sum + rect.top, rects[1].height / 2) };`);
    assert(point, `不可见的控件：${locator}`);
    await clickOn(client, sessionId, point);
  }
  await until("真实画布打开", () => inWorkbench<boolean>(`
    return visible(editor) && Boolean(doc?.querySelector('canvas.interactive')) &&
      new URL(editor.src).searchParams.get('id') === ${JSON.stringify(canvas.id)} || false;`));
  await inWorkbench(`const host = code.contentWindow;
    host.__designViewportProbe = { document: doc, element: editor, selected: [] };
    host.addEventListener('message', (event) => {
      if (event.source === editor.contentWindow && event.origin === location.origin && event.data?.type === 'kenfutwork:canvas-context')
        host.__designViewportProbe.selected = event.data.selectedCanvasElements;
    });`);
  await click("放大", true);
  const scaled = await until("画布放大", () => inWorkbench<string | false>("return zoom() && zoom() !== '100%' ? zoom() : false;"));
  await click("矩形 (R)", true);
  const [left, top] = await inWorkbench<[number, number]>(`return [code, editor].map(node => node.getBoundingClientRect()).reduce((sum, box) => [sum[0]+box.left, sum[1]+box.top], [0, 0]);`);
  for (const [type, x, y, buttons] of [
    ["mousePressed", 125, 305, 1],
    ["mouseMoved", 200, 373, 1],
    ["mouseReleased", 200, 373, 0],
  ] as const) {
    await send("Input.dispatchMouseEvent", { type, x: left + x, y: top + y, button: "left", buttons, clickCount: 1 });
  }
  type Selection = { id: string; type: string; x: number };
  const selected = await until("矩形被选中", () => inWorkbench<Selection | false>(`
    return code.contentWindow.__designViewportProbe.selected.find(item => item.type === 'rectangle') || false;`));
  const canvasToggle = '#browser button[data-testid="side-pane-toggle"]';
  const returnButton = '#conversation-column button[data-testid="side-pane-toggle"]';
  const input = '#conversation-column [contenteditable="true"]';
  await click(canvasToggle);
  await until("草稿返回按钮聚焦", () => inWorkbench<boolean>(`
    const el = shell.querySelector(${JSON.stringify(returnButton)});
    return visible(el) && label(el) === '返回画布' && shell.activeElement === el && !visible(editor) || false;`));
  const draft = "返回画布时保持的会话草稿";
  await click(input);
  await send("Input.insertText", { text: draft });
  await until("草稿就绪", () => inWorkbench<boolean>(`return shell.querySelector(${JSON.stringify(input)}).textContent === ${JSON.stringify(draft)} || false;`));
  await resize(320);
  await click(returnButton);
  await until("返回画布", () => inWorkbench<boolean>("return visible(editor) || false;"));
  const restored = await inWorkbench<{ same: boolean; zoom: string; right: number }>(`
    const probe = code.contentWindow.__designViewportProbe;
    return { same: probe.document === doc && probe.element === editor, zoom: zoom(), right: editor.getBoundingClientRect().right };`);
  assert(restored.same && restored.right <= 320, "画布应保留原页面并在窗口内显示");
  assert.equal(restored.zoom, scaled);
  assert(await inWorkbench(`const interactive = doc.querySelector('.excalidraw[tabindex="0"]');
    editor.contentWindow.focus(); interactive.focus(); return doc.activeElement === interactive;`), "画布键盘操作区应获得焦点");
  await pressKey(client, sessionId, "ArrowRight");
  await until("原选区仍可移动", () => inWorkbench<boolean>(`return code.contentWindow.__designViewportProbe.selected.some(item => item.id === ${JSON.stringify(selected.id)} && item.x > ${selected.x}) || false;`));
  await click(canvasToggle);
  await until("草稿保持", () => inWorkbench<boolean>(`const el = shell.querySelector(${JSON.stringify(input)}); return visible(el) && el.textContent === ${JSON.stringify(draft)} || false;`));
  console.info("Design 窄屏验收通过：返回画布、缩放、原选区与会话草稿均保留。");
} finally {
  if (cdp) {
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
  }
  chrome?.child.kill();
  try {
    await app?.close();
  } finally {
    await db.close();
  }
}
