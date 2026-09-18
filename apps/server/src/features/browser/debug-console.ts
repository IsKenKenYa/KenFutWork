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
}).call(window);`;
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
