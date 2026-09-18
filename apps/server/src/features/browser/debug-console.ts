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
/**
 * 把 Eruda 的容器改成**悬浮窗**（可拖动 / 可关闭）。
 *
 * 三个实现要点：
 * - 它的 DOM 在 **shadow root** 里（`eruda-container` 自建影子根），页面样式进不去，
 *   所以样式要 append 到容器所在的 root（`getRootNode()` 一次拿对，影子根与普通文档都吃）；
 * - 拖动与关闭都挂在容器上（**不新插标题栏**，避免破坏它内部的 flex 布局）：顶部 32px 那一条
 *   按下即拖（直接改内联 left/top），✕ 绝对定位浮在右上角；
 * - 幂等：`window.__kfwFloating` 标记，重复点不会叠第二套监听。
 */
const FLOAT_SCRIPT = `
;(function () {
  // 重新打开：把上一次「关闭」按下去的 display 放回来（幂等，不叠监听）
  if (window.__kfwFloating) {
    var again = document.querySelector(".eruda-container");
    if (again) again.style.removeProperty("display");
    if (window.eruda) window.eruda.show();
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
    ".eruda-container{position:fixed!important;left:24px;top:24px;right:auto!important;" +
    "bottom:auto!important;width:460px!important;height:340px!important;" +
    "max-width:none!important;max-height:none!important;border-radius:6px!important;" +
    "box-shadow:0 10px 28px rgba(0,0,0,.35)!important;z-index:2147483646!important;" +
    "overflow:hidden!important;" +
    // Eruda 把容器设成 pointer-events:none（只有内层面板收事件）：悬窗形态下整块都要收
    // ——否则顶部那一条拖动区点不到（真机实测：拖不动就是栽在这里）。
    "pointer-events:auto!important;" +
    ".eruda-dev-tools{pointer-events:auto!important}" +
    ".eruda-entry-btn{display:none!important}";
  (root.head || root).appendChild(style);

  var close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "关闭调试控制台";
  close.setAttribute("aria-label", "关闭调试控制台");
  close.style.cssText =
    "position:absolute;right:2px;top:2px;z-index:10;width:20px;height:20px;" +
    "line-height:18px;font-size:14px;border:1px solid rgba(0,0,0,.15);border-radius:4px;" +
    "background:#fff;color:#333;cursor:pointer;padding:0";
  close.onclick = function (event) {
    event.stopPropagation();
    if (window.eruda) window.eruda.hide();
    // 我们给容器加了 width/height/overflow，光 hide() 会留一个空框在页面上（真机看到的就是
    // 「内容没了、框还在」）——所以整块收起来；下次注入时再把 display 放回来。
    container.style.setProperty("display", "none", "important");
    if (window.__kfwFloatingClose) window.__kfwFloatingClose();
  };
  container.appendChild(close);
  container.title = "调试控制台：拖顶部可移动，点右上角关闭";

  var dragging = null;
  container.addEventListener(
    "mousedown",
    function (event) {
      if (event.target === close) return;
      var box = container.getBoundingClientRect();
      // 只认顶部那一条（标签栏），下面的正文照常交互
      if (event.clientY - box.top > 32) return;
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
