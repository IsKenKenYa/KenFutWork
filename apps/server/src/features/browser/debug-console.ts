import { CdpError } from "./cdp-client.js";

/**
 * 「打开调试工具」注入的**页面内调试控制台**（Eruda）脚本来源。
 *
 * 为什么由服务端取脚本、**把源码整段注入**（而不是往页面里插一个 `<script src=…>`）：
 * - 页面里插 script 标签把成败交给了那个页面的网络与策略（CSP、外部脚本拦截、加载顺序），
 *   真机上就撞到过——注入报成功、页面上什么都没有（用户在面板里看到「点了没反应」）；
 * - 源码直投走 `Runtime.evaluate`，是**运行代码**而不是新增资源请求，上面那一类失败不存在；
 * - 顺带把 CDN 依赖收在服务端一处（页面不必联网到 CDN），也便于自检「到底生效没有」。
 *
 * 脚本在服务端缓存（几百 KB，一次取；失败不缓存，下次还能重试）。两端共用同一份源码：
 * - Web / 自托管形态：CDP `Runtime.evaluate` 注入到受控页面；
 * - 桌面外壳：`GET /api/browser/debug-console.js` 取同一份源码，`eval` 进面板里的子 WebView2。
 */

/** 脚本来源（钉住版本；要换源或自托管镜像只改这一处）。 */
export const DEBUG_CONSOLE_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/eruda@3.4.1/eruda.min.js";

/**
 * 源码之后要接的启动尾巴：初始化 + 显示。
 *
 * 幂等——重复点「打开调试工具」只是把已经加载的控制台再显示一次，不会叠出第二个。
 * 出错时把原因写到 `window.__kfwDebugConsoleError`：页面里的异常浏览器控制台才看得到，
 * 服务端只能靠这个自报（否则又是「点了没反应」那种哑失败）。
 *
 * 形态：用户口径「内嵌的控制台做成悬浮窗，可以拖动、可以关闭」——Eruda 默认是贴页面底部的
 * 抽屉，所以注入后再加一步 `FLOAT_SCRIPT`：把容器摆成一块悬浮窗，并接上拖动与关闭。
 * **不自己重写一个控制台**：Eruda 是现成的页面内调试控制台（Console / Elements / Network /
 * Sources / Storage 全都有），我们只改它的形态。
 */
const START_TAIL = `
;(function () {
  window.__kfwDebugConsoleError = null;
  try {
    if (!window.eruda) {
      window.__kfwDebugConsoleError = "脚本没有把 eruda 挂到 window 上";
      return;
    }
    window.eruda.init();
    window.eruda.show();
  } catch (error) {
    window.__kfwDebugConsoleError = String(
      (error && (error.stack || error.message)) || error
    );
  }
})();`;

/**
 * 把 Eruda 的容器改造成**三态窗口**（用户口径 2026-10-20）：
 * - **悬浮**（默认）：实底悬浮窗，顶部标签栏拖动移动，右下角缩放，右上角三按钮；
 * - **最小化**：收成**悬浮球**贴边半藏（图标与「打开调试工具」菜单同款 SquareTerminal），
 *   悬停滑出、点一下还原悬浮窗；
 * - **最大化**：贴页面底部的全宽遮罩，上边线 `ns-resize` 上下箭头可拖高度，右上角同样三按钮。
 *
 * 实现要点：
 * - Eruda 的 DOM 在 **shadow root** 里，页面样式进不去——样式与悬浮球都挂在容器所在的
 *   root（`getRootNode()` 拿对，影子根与普通文档都吃）；
 * - 按钮条/边线手柄直接 append 到容器（不新插标题栏，避免破坏它内部 flex）；
 * - 实底：容器显式 `background:#fff`——Eruda 自身不保证给容器上底色，透明面板真机被用户
 *   圈过（页面内容透出来像坏掉）；
 * - 幂等：`window.__kfwFloating` 标记，重复点「打开调试工具」从任何状态回到悬浮窗。
 */
const FLOAT_SCRIPT = `
;(function () {
  // 重新打开：从任何状态（关闭/悬浮球/最大化）回到悬浮窗（幂等，不叠监听）
  if (window.__kfwFloating) {
    var again = document.querySelector(".eruda-container");
    if (again) again.style.removeProperty("display");
    if (window.eruda) window.eruda.show();
    if (window.__kfwConsoleRestore) window.__kfwConsoleRestore();
    return;
  }
  // 容器可能在**影子根**里（Eruda 自己建的）：document.querySelector 穿不过去，
  // 所以先直查、再逐个影子根里找。
  function findContainer() {
    var direct = document.querySelector(".eruda-container");
    if (direct) return direct;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i += 1) {
      var shadow = all[i].shadowRoot;
      if (!shadow) continue;
      var found = shadow.querySelector(".eruda-container");
      if (found) return found;
    }
    return null;
  }
  var container = findContainer();
  if (!container) {
    window.__kfwDebugConsoleError = "找不到 eruda 容器，没法做成悬浮窗";
    return;
  }
  var root = container.getRootNode ? container.getRootNode() : document;
  var style = document.createElement("style");
  style.textContent =
    ".eruda-container{position:fixed!important;background:#fff!important;" +
    "z-index:2147483646!important;pointer-events:auto!important;box-sizing:border-box!important}" +
    // 悬浮态：位置/尺寸都由 CSS 变量驱动（拖动改 --kfw-x/--kfw-y，角柄改宽高）
    ".eruda-container.kfw-float{left:24px;top:24px;right:auto!important;bottom:auto!important;" +
    "width:var(--kfw-w,460px)!important;height:var(--kfw-h,340px)!important;" +
    "max-width:none!important;max-height:none!important;border-radius:6px!important;" +
    "box-shadow:0 10px 28px rgba(0,0,0,.35)!important;overflow:hidden!important}" +
    // 最大化态：贴底全宽遮罩，高度由 --kfw-mh 驱动（上边线拖拽改它）
    ".eruda-container.kfw-max{left:0!important;right:0!important;top:auto!important;bottom:0!important;" +
    "width:auto!important;height:var(--kfw-mh,60vh)!important;max-width:none!important;" +
    "max-height:none!important;border-radius:8px 8px 0 0!important;" +
    "box-shadow:0 -8px 28px rgba(0,0,0,.35)!important;overflow:hidden!important}" +
    // Eruda 的正文面板自己留了一条顶部空档（原来是放标题的）：拉满整块，
    // 同时让可见的标签栏正好落在拖动条里。
    ".eruda-dev-tools{top:0!important;height:100%!important;pointer-events:auto!important}" +
    ".eruda-entry-btn{display:none!important}" +
    // 右上角三按钮（悬浮/最大化两态都显示；最大化时即面板右上=屏幕右上）
    ".kfw-btnbar{position:absolute;right:2px;top:2px;z-index:2147483647;display:flex;gap:2px}" +
    ".kfw-btn{width:20px;height:20px;line-height:18px;font-size:13px;font-family:system-ui,sans-serif;" +
    "border:1px solid rgba(0,0,0,.15);border-radius:4px;background:#fff;color:#333;cursor:pointer;padding:0}" +
    ".kfw-btn:hover{background:#eee}" +
    // 最大化态的上边线：上下箭头光标 + 拖拽改高度
    ".kfw-edge{position:absolute;left:0;right:0;top:-4px;height:8px;cursor:ns-resize;" +
    "z-index:2147483647;display:none}" +
    ".eruda-container.kfw-max .kfw-edge{display:block}" +
    // 悬浮态右下角缩放手柄（最大化态藏起，改由上边线管高度）
    ".kfw-corner{position:absolute;right:0;bottom:0;z-index:2147483647;width:14px;height:14px;" +
    "cursor:nwse-resize;background:linear-gradient(135deg,transparent 45%,#999 45%,#999 55%,transparent 55%)}" +
    ".eruda-container.kfw-max .kfw-corner{display:none}" +
    // 悬浮球：贴边半藏（默认露出不到一半，悬停滑出），点击还原
    ".kfw-ball{position:fixed;z-index:2147483647;width:44px;height:44px;border-radius:50%;" +
    "background:#1a73e8;color:#fff;display:none;align-items:center;justify-content:center;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;transition:transform .18s ease}" +
    ".kfw-ball-left{left:0;transform:translateX(-58%)}" +
    ".kfw-ball-right{right:0;transform:translateX(58%)}" +
    ".kfw-ball-left:hover{transform:translateX(-16%)}" +
    ".kfw-ball-right:hover{transform:translateX(16%)}";
  (root.head || root).appendChild(style);
  // 悬浮球挂在与样式同一个 root（样式进影子根的话，挂 document.body 会丢样式）
  var hostRoot = root === document ? document.body : root;

  function mkBtn(glyph, tip, label) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = glyph;
    b.title = tip;
    b.setAttribute("aria-label", label);
    b.className = "kfw-btn";
    return b;
  }
  var btnbar = document.createElement("div");
  btnbar.className = "kfw-btnbar";
  btnbar.title = "调试控制台";
  var minBtn = mkBtn("–", "最小化为悬浮球", "最小化调试控制台");
  var maxBtn = mkBtn("□", "最大化（贴底）", "最大化调试控制台");
  var closeBtn = mkBtn("×", "关闭调试控制台", "关闭调试控制台");
  btnbar.appendChild(minBtn);
  btnbar.appendChild(maxBtn);
  btnbar.appendChild(closeBtn);
  container.appendChild(btnbar);

  // 悬浮球（图标与「打开调试工具」菜单同款：lucide square-terminal）
  var ball = document.createElement("div");
  ball.className = "kfw-ball";
  ball.title = "调试控制台";
  ball.setAttribute("aria-label", "还原调试控制台");
  ball.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m7 11 2-2-2-2"></path><path d="M11 13h4"></path>' +
    '<rect width="18" height="18" x="3" y="3" rx="2"></rect></svg>';
  hostRoot.appendChild(ball);

  function applyFloat() {
    container.style.removeProperty("display");
    container.classList.add("kfw-float");
    container.classList.remove("kfw-max");
    ball.style.display = "none";
    maxBtn.title = "最大化（贴底）";
    if (window.eruda) window.eruda.show();
  }
  function applyMax() {
    var rect = container.getBoundingClientRect();
    var height = Math.round(
      Math.max(180, Math.min(rect.height, window.innerHeight * 0.8), window.innerHeight * 0.45),
    );
    container.style.setProperty("--kfw-mh", height + "px");
    container.classList.add("kfw-max");
    container.classList.remove("kfw-float");
    container.style.removeProperty("display");
    ball.style.display = "none";
    maxBtn.title = "还原悬浮窗";
    if (window.eruda) window.eruda.show();
  }
  function applyBall() {
    var rect = container.getBoundingClientRect();
    var side =
      rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
    var top = Math.min(
      Math.max(rect.top + rect.height / 2 - 22, 60),
      window.innerHeight - 104,
    );
    ball.className =
      "kfw-ball " + (side === "left" ? "kfw-ball-left" : "kfw-ball-right");
    ball.style.top = Math.round(top) + "px";
    ball.style.display = "flex";
    container.style.setProperty("display", "none", "important");
  }

  minBtn.onclick = function (event) {
    event.stopPropagation();
    applyBall();
  };
  maxBtn.onclick = function (event) {
    event.stopPropagation();
    if (container.classList.contains("kfw-max")) applyFloat();
    else applyMax();
  };
  closeBtn.onclick = function (event) {
    event.stopPropagation();
    if (window.eruda) window.eruda.hide();
    // 我们给容器钉了宽高，光 hide() 会留一个空框在页面上——整块收起；重开时再放回。
    container.style.setProperty("display", "none", "important");
    ball.style.display = "none";
    if (window.__kfwFloatingClose) window.__kfwFloatingClose();
  };
  ball.onclick = function () {
    applyFloat();
  };
  window.__kfwConsoleRestore = applyFloat;

  // 悬浮态右下角缩放手柄：改 CSS 变量（容器宽高由它驱动），夹在可用范围内
  var handle = document.createElement("div");
  handle.className = "kfw-corner";
  handle.title = "拖动调整大小";
  handle.setAttribute("aria-label", "拖动调整调试控制台大小");
  var resizing = null;
  handle.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    resizing = {
      x: event.clientX,
      y: event.clientY,
      w: container.getBoundingClientRect().width,
      h: container.getBoundingClientRect().height,
    };
  });
  window.addEventListener("mousemove", function (event) {
    if (!resizing) return;
    var w = Math.min(900, Math.max(260, resizing.w + (event.clientX - resizing.x)));
    var h = Math.min(700, Math.max(200, resizing.h + (event.clientY - resizing.y)));
    container.style.setProperty("--kfw-w", w + "px");
    container.style.setProperty("--kfw-h", h + "px");
  });
  window.addEventListener("mouseup", function () {
    resizing = null;
  });
  container.appendChild(handle);

  // 最大化态的上边线：ns-resize 拖拽改高度（向上拖变高）
  var edge = document.createElement("div");
  edge.className = "kfw-edge";
  edge.title = "拖动调整高度";
  edge.setAttribute("aria-label", "拖动调整调试控制台高度");
  var edgeDrag = null;
  edge.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    edgeDrag = {
      y: event.clientY,
      h: container.getBoundingClientRect().height,
    };
  });
  window.addEventListener("mousemove", function (event) {
    if (!edgeDrag) return;
    var h = Math.min(
      window.innerHeight - 100,
      Math.max(180, edgeDrag.h + (edgeDrag.y - event.clientY)),
    );
    container.style.setProperty("--kfw-mh", Math.round(h) + "px");
  });
  window.addEventListener("mouseup", function () {
    edgeDrag = null;
  });
  container.appendChild(edge);

  // 悬浮态拖动：只认顶部那一条（标签栏），按钮/手柄不触发；下面的正文照常交互
  var dragging = null;
  container.addEventListener(
    "mousedown",
    function (event) {
      if (event.target === closeBtn) return;
      var t = event.target;
      if (
        t &&
        t.closest &&
        (t.closest(".kfw-btnbar") || t.closest(".kfw-corner") || t.closest(".kfw-edge"))
      )
        return;
      var box = container.getBoundingClientRect();
      // 40px ≈ 可见标签栏那一条（面板拉满后它就贴着容器顶）
      if (event.clientY - box.top > 40) return;
      dragging = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
      event.preventDefault();
    },
    true,
  );
  window.addEventListener("mousemove", function (event) {
    if (!dragging) return;
    var left = Math.max(0, dragging.left + (event.clientX - dragging.x));
    var top = Math.max(0, dragging.top + (event.clientY - dragging.y));
    container.style.setProperty("left", left + "px", "important");
    container.style.setProperty("top", top + "px", "important");
  });
  window.addEventListener("mouseup", function () {
    dragging = null;
  });
  applyFloat();
  window.__kfwFloating = true;
})();`;

/**
 * 把源码包成**可注入的一整段**（源码 + 启动尾巴），并在源码运行期间**藏起 AMD / CJS 的全局**。
 *
 * 为什么必须藏：Eruda 是 UMD 包——页面上只要有 `define`（AMD 加载器）或 `module` / `exports`，
 * 它就注册成模块、**不往 `window` 上挂 `eruda`**。真机实测：百度页面上 `typeof window.define`
 * 是 `function`，注入后 `window.eruda` 始终 undefined（用户看到的正是「点了没反应」）。
 * 藏起来它就只能走「浏览器全局」那条分支；跑完（**哪怕源码抛错**）再原样还回去，
 * 别把人家的 AMD 加载器弄坏。
 *
 * 外层用 `.call(window)`：UMD 拿 `this` 当全局对象，包一层之后 `this` 必须仍是 window。
 */
export function buildInjectableScript(source: string): string {
  return `;(function () {
  var hadModule = Object.prototype.hasOwnProperty.call(window, "module");
  var hadExports = Object.prototype.hasOwnProperty.call(window, "exports");
  var hadDefine = Object.prototype.hasOwnProperty.call(window, "define");
  var savedModule = window.module;
  var savedExports = window.exports;
  var savedDefine = window.define;
  try {
    delete window.module; delete window.exports; delete window.define;
  } catch (error) {
    // 删不掉（不可配置）就退一步赋成 undefined：UMD 的 typeof 判断照样会走全局分支
    window.module = undefined; window.exports = undefined; window.define = undefined;
  }
  try {
${source}
  } finally {
    if (hadModule) window.module = savedModule;
    if (hadExports) window.exports = savedExports;
    if (hadDefine) window.define = savedDefine;
  }
${START_TAIL}
}).call(window);
${FLOAT_SCRIPT}`;
}

export interface DebugConsoleSource {
  /** 可注入的完整脚本（源码 + 启动尾巴）。取不到时抛可读错误。 */
  script(): Promise<string>;
}

export function createDebugConsoleSource(
  options: { fetchImpl?: typeof fetch; url?: string } = {},
): DebugConsoleSource {
  const url = options.url ?? DEBUG_CONSOLE_SCRIPT_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached: Promise<string> | null = null;

  const load = async (): Promise<string> => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new CdpError(
        "command_failed",
        `拿不到调试控制台脚本（${url} 返回 ${response.status}）。`,
      );
    }
    const source = await response.text();
    if (!source.trim()) {
      throw new CdpError("command_failed", "调试控制台脚本是空的，没法注入。");
    }
    return buildInjectableScript(source);
  };

  return {
    script() {
      cached ??= load().catch((error: unknown) => {
        // 失败不缓存：网络恢复后下一次还能成功
        cached = null;
        throw error instanceof Error
          ? error
          : new CdpError("command_failed", "拿不到调试控制台脚本。");
      });
      return cached;
    },
  };
}

/**
 * 注入后自检：脚本真的在页面里生效了吗？
 *
 * 真机教训：只报「已注入」是不够的——脚本没落地时用户看到的是「点了没反应」，
 * 而界面还在说成功。这里读三样东西：脚本有没有挂上 `eruda`、Eruda 自己置的初始化位
 * `_isInit`、以及**页面侧自报的失败原因**（`__kfwDebugConsoleError`，见上面尾巴）。
 */
export const DEBUG_CONSOLE_PROBE = `JSON.stringify({
  loaded: typeof window.eruda !== "undefined",
  initialized: Boolean(window.eruda && window.eruda._isInit),
  containers: document.querySelectorAll(".eruda-container").length,
  error: window.__kfwDebugConsoleError || null
})`;

export interface DebugConsoleProbeResult {
  loaded: boolean;
  initialized: boolean;
  containers: number;
  error: string | null;
}

/** 解析自检探针的返回（页面给的是 JSON 串；拿不到就当作「没生效」）。 */
export function parseDebugConsoleProbe(
  value: unknown,
): DebugConsoleProbeResult {
  const fallback: DebugConsoleProbeResult = {
    loaded: false,
    initialized: false,
    containers: 0,
    error: null,
  };
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<DebugConsoleProbeResult>;
    return {
      loaded: parsed.loaded === true,
      initialized: parsed.initialized === true,
      containers: typeof parsed.containers === "number" ? parsed.containers : 0,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return fallback;
  }
}
