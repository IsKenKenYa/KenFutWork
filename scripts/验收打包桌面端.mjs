/**
 * 打包桌面端（安装后的 exe）真机验收脚本。
 *
 * 为什么要有它：同一句「Design 是画布」在 dev 与打包态是**两条链路**——
 * dev 走 `next dev` + 同源 rewrite，打包态走「服务端托管静态导出 + 本机免登录」。
 * dev 验过不等于打包成立：2026-09-19 安装包上「画布起不来」的三处原因（壳复用了别人的
 * 服务、打包 UI 的 API base 被烘成开发值、免登录没有令牌导致几十处客户端门不放行）
 * 在 dev 里一个都看不见。这个脚本把打包态的关键不变量钉住，改壳/改打包脚本后跑一遍即可。
 *
 * 用法（Windows，桌面端已安装）：
 *   node scripts/验收打包桌面端.mjs
 *   node scripts/验收打包桌面端.mjs --exe "C:\\path\\to\\kenfutwork-desktop.exe"
 *
 * 做法：给壳带上 WebView2 的调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`），
 * 起来后用 CDP 断言四件事：
 *   1. 窗口页面是**回环 http**（服务端托管的 UI），不是壳自带的 `tauri://localhost`；
 *   2. 侧栏拿得到身份（免登录形态显示「本机用户」，不是「未登录」）；
 *   3. 切 Design 后主区出现 `/canvas?id=…` 的 iframe；
 *   4. iframe 里的画布**真的渲染了**（Excalidraw 容器在 DOM 里）。
 * 通过则退出码 0，并在 `.kenfutwork/scratch/packaged-canvas.png` 落一张截图。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEBUG_PORT = Number(process.env.KFW_CDP_PORT ?? 9333);
const SHOT = join(
  process.cwd(),
  ".kenfutwork",
  "scratch",
  "packaged-canvas.png",
);

function defaultExe() {
  const candidates = [
    join(
      process.env.LOCALAPPDATA ?? homedir(),
      "Programs",
      "KenFutWork",
      "kenfutwork-desktop.exe",
    ),
    "D:\\Program Files\\KenFutWork\\kenfutwork-desktop.exe",
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

const exeArgIndex = process.argv.indexOf("--exe");
const exe = exeArgIndex >= 0 ? process.argv[exeArgIndex + 1] : defaultExe();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/version`,
      );
      if (response.ok) return await response.json();
    } catch {
      // 还没起来：继续等
    }
    await sleep(1000);
  }
  throw new Error(
    `等不到 WebView2 调试端口 ${DEBUG_PORT}：壳没起来，或它没带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`,
  );
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket，不引第三方依赖）。 */
function connect(browserWebSocketUrl) {
  const socket = new WebSocket(browserWebSocketUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error
      ? entry.reject(new Error(message.error.message))
      : entry.resolve(message.result ?? {});
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 15000);
    });
  return { socket, ready, send };
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

if (!existsSync(exe)) {
  console.error(`找不到桌面壳：${exe}（用 --exe 指定）`);
  process.exit(1);
}

console.log(`启动安装后的壳：${exe}`);
const child = spawn(exe, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
  },
});
child.unref();

const version = await waitForEndpoint();
const { socket, ready, send } = connect(version.webSocketDebuggerUrl);
await ready;

/**
 * 等窗口**加载完**再挂：壳起来时窗口先是 `about:blank`，随后才被导航到服务端托管的 UI
 * （服务端还要先起内嵌 PG）。早挂会拿不到任何断言目标。
 */
async function waitForUiTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const targets = await send("Target.getTargets");
    const hit = targets.targetInfos.find(
      (info) =>
        info.type === "page" &&
        !info.url.startsWith("devtools://") &&
        info.url.startsWith("http://127.0.0.1"),
    );
    if (hit) return hit;
    await sleep(1000);
  }
  const targets = await send("Target.getTargets");
  throw new Error(
    `等不到窗口加载本机 UI（当前 target：${targets.targetInfos.map((t) => t.url).join(", ")}）`,
  );
}

const page = await waitForUiTarget();
const { sessionId } = await send("Target.attachToTarget", {
  targetId: page.targetId,
  flatten: true,
});
await send("Runtime.enable", {}, sessionId);
const evaluate = async (expression) => {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  return result.result?.value;
};

// ① 窗口必须是服务端托管的回环 UI
const href = await evaluate("location.href");
check(
  typeof href === "string" && href.startsWith("http://127.0.0.1:"),
  `窗口页面是回环 http：${href}`,
);
const workbench =
  /\/workbench/.test(String(href)) || /\/canvas/.test(String(href));
check(workbench, "窗口落在工作台/画布路由上");

// ② 免登录身份拿得到（不是「未登录」）
await sleep(3000);
const signedIn = await evaluate(
  `(() => { const text = document.body.innerText; return { hasUser: text.includes("本机用户"), hasGuest: text.includes("未登录") }; })()`,
);
check(signedIn?.hasUser === true, "侧栏拿到免登录身份（本机用户）");
check(signedIn?.hasGuest !== true, "侧栏没有停在「未登录」");

// ③ 切 Design，主区出现画布 iframe
const clicked = await evaluate(
  `(() => {
     const nodes = [...document.querySelectorAll("button,[role=tab],[role=button],div[data-state]")];
     const hit = nodes.find((n) => (n.textContent ?? "").trim() === "Design");
     if (!hit) return false;
     hit.click();
     return true;
   })()`,
);
check(clicked === true, "切到 Design 模式");
await sleep(4000);

const shape = await evaluate(
  `(() => ({
     frames: [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src")),
     text: document.body.innerText.slice(0, 200),
   }))()`,
);
const canvasFrame = (shape?.frames ?? []).find((src) =>
  String(src ?? "").includes("/canvas"),
);
check(
  Boolean(canvasFrame),
  `Design 主区是画布 iframe：${canvasFrame ?? "没有"}`,
);

// ④ 画布真的渲染（Excalidraw 容器在 DOM 里）
const canvasState = await evaluate(
  `(async () => {
     const frame = [...document.querySelectorAll("iframe")].find((f) => (f.getAttribute("src") ?? "").includes("/canvas"));
     if (!frame) return { excalidraw: 0, text: "没有画布 iframe" };
     for (let i = 0; i < 40; i += 1) {
       const doc = frame.contentDocument;
       const found = doc?.querySelectorAll?.(".excalidraw").length ?? 0;
       if (found > 0) {
         return { excalidraw: found, canvasEl: doc.querySelectorAll("canvas").length, url: frame.src };
       }
       await new Promise((r) => setTimeout(r, 500));
     }
     return { excalidraw: 0, text: (frame.contentDocument?.body?.innerText ?? "").slice(0, 120) };
   })()`,
);
check(
  (canvasState?.excalidraw ?? 0) > 0,
  `画布已渲染（.excalidraw=${canvasState?.excalidraw ?? 0}，canvas 元素=${canvasState?.canvasEl ?? 0}）`,
);

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
mkdirSync(dirname(SHOT), { recursive: true });
writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
console.log(`截图：${SHOT}`);

/**
 * ⑤ 模型目录为空时，模型选择器必须给得出路。
 *
 * 打包版首启动没有任何供应商（BYOK 没填过、也没有 `.env.local`），`/api/models` 是空数组。
 * 此前选择器只渲染一个「默认模型」单项，用户点开也没路可走（2026-09-19 用户问「为什么
 * 桌面版这个不显示」）；现在应显示「未配置模型」+「添加供应商…」。目录非空时这条不适用。
 */
const modelCount = await evaluate(
  `fetch("/api/models").then((r) => r.json()).then((d) => (d.models ?? []).length)`,
);
if (modelCount === 0) {
  await evaluate(
    `(() => {
       const code = [...document.querySelectorAll("button,[role=tab],[role=button]")].find((n) => (n.textContent ?? "").trim() === "Code");
       if (code) code.click();
       return true;
     })()`,
  );
  await sleep(2500);
  const opened = await evaluate(
    `(() => {
       const trigger = [...document.querySelectorAll("[role=combobox],button")].find((el) => (el.textContent ?? "").trim().startsWith("未配置模型"));
       if (!trigger) return false;
       trigger.click();
       return true;
     })()`,
  );
  await sleep(1200);
  const emptyState = await evaluate(
    `(() => ({
       options: [...document.querySelectorAll("[role=option],[role=menuitem]")].map((el) => (el.textContent ?? "").trim()),
       hasAdd: [...document.querySelectorAll("button")].some((el) => (el.textContent ?? "").trim().startsWith("添加供应商")),
     }))()`,
  );
  check(opened === true, "空模型目录时模型选择器可点开");
  check(
    (emptyState?.options ?? []).some((text) => text.includes("未配置模型")) &&
      emptyState?.hasAdd === true,
    `空模型目录时给出「添加供应商…」出口（下拉项：${(emptyState?.options ?? []).join(" / ")}）`,
  );
} else {
  console.log(`· 模型目录非空（${modelCount} 条），跳过「空目录出口」检查`);
}

socket.close();

if (failures.length > 0) {
  console.error(`\n验收不通过（${failures.length} 项）：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log("\n打包桌面端验收通过：Design 模式主区就是画布。");
