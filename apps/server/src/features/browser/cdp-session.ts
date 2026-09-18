import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BlobStore } from "../blob/types.js";
import {
  ackScreencastFrame,
  type CdpClient,
  CdpError,
  captureScreenshot,
  clickOn,
  connectCdpClient,
  dispatchKey,
  dispatchMouse,
  dispatchWheel,
  findBrowserExecutable,
  killStaleProfileInstance,
  launchBrowserWithDebugPort,
  pressKey,
  readDom,
  readPickables,
  readViewport,
  setViewportOverride,
  startScreencast,
  stopScreencast,
  typeText,
  waitForDevtools,
  waitForLoad,
} from "./cdp-client.js";
import {
  createDebugConsoleSource,
  DEBUG_CONSOLE_PROBE,
  type DebugConsoleSource,
  parseDebugConsoleProbe,
} from "./debug-console.js";
import { samePageUrl } from "./view-stream.js";

/**
 * CDP 浏览器会话（R5-4「连接到 Chrome」/「自动截图」的执行面）。
 *
 * 一条会话 = 一个**独立 profile 的浏览器实例** + 一个受控标签页：
 * - `connect()`：找浏览器 → 带调试端口启动 → 等端口 → 连 WebSocket → 开标签；
 * - 命令：导航 / 真实 DOM 读取 / 截图 / 点击 / 输入 / 按键；
 * - `screenshot` 走 blob（`project-assets`，与生成物同一条路），返回可直接上屏的 URL；
 * - `disconnect()`：断开并**杀掉我们自己起的实例**（不动用户日常窗口）。
 *
 * 安全：只连 127.0.0.1 的调试端口；profile 目录在**系统临时目录**下
 * （`<os.tmpdir()>/kenfutwork-chrome-profile`），不碰用户真实 profile（也因此拿不到
 * 用户已登录的会话——这是刻意的：不给 agent 用户的浏览器身份）。
 *
 * 为什么不放仓库的 `.kenfutwork/`（原实现就是那里，真机验收后改掉）：浏览器 profile 是
 * 几百 MB 的缓存 + Chrome 自带的预装扩展，**扩展目录里带 `*.test.js` / `*.spec.js`**——
 * 放仓库里会被 vitest 的默认 include 当成测试文件收集，全量测试当场出现 42 个
 * 「失败文件」（跑的是 Adobe Acrobat 扩展的用例），与本项目无关却把门禁搞红。
 */

export const CDP_DEFAULT_PORT = 9333;

export type CdpStatus =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      browser: string;
      port: number;
      tabs: number;
      currentUrl: string;
      /** 是否由我们启动（决定 disconnect 时要不要杀进程）。 */
      owned: boolean;
      headless: boolean;
    }
  | { status: "error"; message: string };

export interface CdpBrowserSession {
  status(): CdpStatus;
  connect(options?: {
    headless?: boolean;
    port?: number;
    profileDir?: string;
    executable?: string;
  }): Promise<CdpStatus>;
  disconnect(): Promise<CdpStatus>;
  /**
   * **注入调试控制台**（Eruda）到受控页面——用户口径「直接打开的就是调试面板，不要转接一层」。
   *
   * 这是移动端 H5 调试的标准做法：Console / Network / Elements / Storage 全都有，
   * 浮在页面底部，点一下就出来，不需要另开窗口。注入通过 CDP `Runtime.evaluate`
   * 在页面里插一个 `<script>` 标签（从 CDN 加载 Eruda）。
   */
  injectDebugConsole(url: string): Promise<{ url: string }>;
  /**
   * 调试控制台脚本源码（含启动尾巴）——桌面形态从 `/api/browser/debug-console.js`
   * 取**同一份**，`eval` 进面板里的子 WebView2（两端不各存一份脚本）。
   */
  debugConsoleScript(): Promise<string>;
  /** 导航（复用受控标签，没有就开一个）。 */
  navigate(url: string): Promise<{
    url: string;
    title: string;
    text: string;
    elements: Array<{ tag: string; text: string; hint: string }>;
  }>;
  snapshot(): Promise<{
    url: string;
    title: string;
    text: string;
    elements: Array<{ tag: string; text: string; hint: string }>;
  }>;
  /**
   * 可拾取元素（带真实几何，见 cdp-client 的 readPickables）+ 一张当前视口截图。
   * 截图落 blob 后给签名 URL；blob 不可用或截图失败时只少 `screenshotUrl`，几何照给。
   */
  pickables(): Promise<{
    url: string;
    title: string;
    viewport: { width: number; height: number };
    elements: Array<{
      tag: string;
      text: string;
      hint: string;
      box: { x: number; y: number; width: number; height: number } | null;
    }>;
    screenshotUrl?: string;
  }>;
  screenshot(): Promise<{
    screenshotUrl: string;
    width: number;
    height: number;
  }>;
  click(target: { selector?: string; x?: number; y?: number }): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  /**
   * **右栏面板的画面上屏**：把受控标签的画面以 JPEG 帧推给调用方，返回停止函数。
   *
   * 为什么要这条路（而不是继续用 iframe）：面板里的 iframe 是**跨源**的，既挂不上调试工具
   * 也注不进任何脚本——用户口径「调试面板要在内嵌页面里出来」在 iframe 上不可能实现。
   * 把面板显示成受控浏览器自己的画面后，注入到页面的调试控制台就**出现在面板里**。
   */
  watch(
    options: { width?: number; height?: number; quality?: number },
    onFrame: (jpeg: Buffer) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  /** 视口 CSS 尺寸（面板里把鼠标坐标换算成视口坐标要用它）。 */
  viewport(): Promise<{ width: number; height: number; scale: number }>;
  /** 面板内的交互回填（鼠标 / 滚轮 / 键盘 / 文本）。 */
  input(event: CdpInputEvent): Promise<void>;
  /**
   * 「自由尺寸」：真实改变页面视口（`null` = 还原）。传 `null` 之外的值时返回新的视口尺寸。
   */
  resize(size: { width: number; height: number } | null): Promise<void>;
  listTabs(): Promise<Array<{ url: string; title: string }>>;
  /** 会话是否可用（工具与端点在调用前判）。 */
  isConnected(): boolean;
}

/** 面板内交互事件（坐标是**视口 CSS px**，由客户端按显示尺寸换算好）。 */
export type CdpInputEvent =
  | {
      type: "mouse";
      action: "pressed" | "released" | "moved";
      x: number;
      y: number;
      /** `none` = 只是移动（没有按着任何键）。 */
      button?: "left" | "right" | "middle" | "none";
      buttons?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX?: number;
      deltaY?: number;
    }
  | { type: "key"; key: string; code?: string; modifiers?: number }
  | { type: "text"; text: string };

export function createCdpBrowserSession(deps: {
  /** 截图落 blob 用；缺省时截图只返回 base64 长度（测试/无 blob 装配）。 */
  blob?: BlobStore | undefined;
  /** 数据目录（默认系统临时目录下的 `kenfutwork-chrome-profile`，见模块头注）。 */
  dataDir?: string;
  /** 测试注入。 */
  findExecutable?: typeof findBrowserExecutable;
  launch?: typeof launchBrowserWithDebugPort;
  waitDevtools?: typeof waitForDevtools;
  connectClient?: typeof connectCdpClient;
  /** 测试注入：收掉「用着我们 profile 的残留实例」（默认按命令行匹配后 taskkill/pkill）。 */
  killStaleProfile?: typeof killStaleProfileInstance;
  /** 测试注入：调试控制台脚本来源（默认从 CDN 取一次并缓存）。 */
  debugConsole?: DebugConsoleSource;
}): CdpBrowserSession {
  const dataDir = deps.dataDir ?? join(tmpdir(), "kenfutwork-chrome-profile");
  const debugConsole = deps.debugConsole ?? createDebugConsoleSource();
  let state: CdpStatus = { status: "disconnected" };
  let client: CdpClient | null = null;
  let child: ChildProcess | null = null;
  let sessionId: string | null = null;
  let portrait = { width: 1280, height: 720 };

  const requireConnected = (): { client: CdpClient; sessionId: string } => {
    if (!client || !sessionId) {
      throw new CdpError(
        "connect_failed",
        "浏览器未连接：请到「设置 → 浏览器 → 外部浏览器」点『连接到 Chrome』。",
      );
    }
    return { client, sessionId };
  };

  /**
   * 关掉**空闲的空白页**（保留我们正在用的那块）。
   *
   * 为什么需要：连接时为了拿一块会话标签开过一个 `about:blank`，新 profile 自己也会带一个空白页——
   * 导航之后它们就成了窗口里的「多余标签」（用户口径：不该出现「空白页 + 页面本身 + 调试工具」三连）。
   * 只动 `about:blank`：那上面不可能有用户内容；用户自己开的页面一律不碰。
   */
  const closeIdleBlanks = async (target: CdpClient): Promise<void> => {
    try {
      const targets = await target.listTargets();
      const current = sessionId
        ? targets.find((entry) => entry.targetId === currentTargetId)
        : undefined;
      for (const entry of targets) {
        if (entry.url !== "about:blank") continue;
        if (current && entry.targetId === current.targetId) continue;
        await target.closeTab(entry.targetId).catch(() => undefined);
      }
    } catch {
      // 清理是尽力而为：失败不影响主流程
    }
  };

  /** 我们正在用的那块页面 target（清理空白页时要放过它）。 */
  let currentTargetId: string | null = null;
  /** 当前画面流订阅（同时只留一个，见 `watch`）。 */
  let activeWatcher: (() => Promise<void>) | null = null;
  /** 导航事件订阅（退订用，见 `trackNavigation`）。 */
  let offNavigation: (() => void) | null = null;

  /**
   * 跟踪**页面自己发起的导航**（点链接、表单提交、JS 跳转）。
   *
   * `currentUrl` 原先只在 `navigate()` 里更新，于是页面自己跳走之后状态停在旧地址——真机实测
   * 撞上了：点链接后画面已经是新页，`status()` 还报旧页，面板的「是不是同一页」判断跟着错
   * （地址栏与画面各说一套）。
   */
  const trackNavigation = (target: CdpClient, id: string): void => {
    if (offNavigation) return;
    void target.send("Page.enable", {}, id).catch(() => undefined);
    offNavigation = target.on(
      "Page.frameNavigated",
      (params, eventSessionId) => {
        if (eventSessionId && eventSessionId !== id) return;
        const frame = params.frame as
          | { url?: unknown; parentId?: unknown }
          | undefined;
        const url = typeof frame?.url === "string" ? frame.url : "";
        // 只认主框架：子框架（iframe）自己跳走不该改「当前页」
        if (!url || typeof frame?.parentId === "string") return;
        if (state.status === "connected") {
          state = { ...state, currentUrl: url };
        }
      },
    );
  };

  const ensureTab = async (
    target: CdpClient,
    url?: string,
  ): Promise<string> => {
    if (sessionId) {
      if (url) {
        await target.send("Page.navigate", { url }, sessionId);
        await waitForLoad(target, sessionId);
      }
      return sessionId;
    }
    const opened = await target.openTab(url ?? "about:blank");
    if (url) await waitForLoad(target, opened.sessionId);
    sessionId = opened.sessionId;
    currentTargetId = opened.targetId;
    trackNavigation(target, opened.sessionId);
    return sessionId;
  };

  /** 截一张当前视口并落到 blob（`screenshot()` 与 `pickables()` 共用）。 */
  const captureAndUpload = async (
    cdp: CdpClient,
    id: string,
  ): Promise<{ screenshotUrl: string; width: number; height: number }> => {
    const bytes = await captureScreenshot(cdp, id);
    if (!deps.blob) {
      throw new CdpError(
        "command_failed",
        "服务端没有装配 blob 存储，截图无法落盘。",
      );
    }
    const objectPath = `browser/${Date.now()}-${Math.round(portrait.width)}x${Math.round(portrait.height)}.png`;
    const bucket = deps.blob.bucket("project-assets");
    await bucket.upload(objectPath, bytes, {
      contentType: "image/png",
      upsert: true,
    });
    const screenshotUrl = await bucket.resolveUrl(objectPath, 3600);
    return { screenshotUrl, width: portrait.width, height: portrait.height };
  };

  const session: CdpBrowserSession = {
    status() {
      return state;
    },
    isConnected() {
      return state.status === "connected";
    },
    async connect(options = {}) {
      if (state.status === "connected" && client) return state;
      state = { status: "connecting" };
      const headless = options.headless ?? false;
      try {
        const executable =
          options.executable ??
          (deps.findExecutable ?? findBrowserExecutable)(undefined);
        if (!executable) {
          throw new CdpError(
            "chrome_not_found",
            "没找到 Chrome / Edge / Chromium。请安装其一，或用 KENFUTWORK_CHROME_PATH 指定可执行文件路径。",
          );
        }
        const port = options.port ?? CDP_DEFAULT_PORT;
        const profileDir =
          options.profileDir ?? join(dataDir, "chrome-profile");
        /**
         * **先收掉用着我们 profile 的残留实例**：Chrome 对同一个 `--user-data-dir` 只允许一个
         * 进程，新的一次启动会「交棒」给旧进程并立刻退出——于是「启动参数」永远加不上
         * （典型后果：`--remote-allow-origins` 缺失，调试前端打开即断；用户真机就这么卡住的）。
         * 只匹配我们自己的 profile 路径，用户日常的 Chrome 不受影响。
         */
        await (deps.killStaleProfile ?? killStaleProfileInstance)(
          profileDir,
          port,
        );
        const launched = await (deps.launch ?? launchBrowserWithDebugPort)({
          executable,
          port,
          profileDir,
          headless,
        });
        child = launched.child;
        const version = await (deps.waitDevtools ?? waitForDevtools)(port);
        client = (deps.connectClient ?? connectCdpClient)(
          version.webSocketDebuggerUrl,
        );
        sessionId = null;
        currentTargetId = null;
        // 新客户端：旧的退订句柄作废（否则 trackNavigation 会以为已经订阅过）
        offNavigation = null;
        await ensureTab(client);
        const tabs = await client.listTargets();
        state = {
          status: "connected",
          browser: version.browser,
          port,
          tabs: tabs.length,
          currentUrl: tabs[0]?.url ?? "about:blank",
          owned: true,
          headless,
        };
        // 进程若自己退了，把状态收回 disconnected（下次调用会给出可读原因）
        child.once("exit", () => {
          if (state.status === "connected") {
            state = {
              status: "error",
              message: "浏览器实例已退出（窗口被关闭或进程被杀）",
            };
          }
          client?.close();
          client = null;
          child = null;
          sessionId = null;
        });
        return state;
      } catch (error) {
        await session.disconnect().catch(() => undefined);
        state = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        return state;
      }
    },
    async debugConsoleScript() {
      return debugConsole.script();
    },
    async injectDebugConsole(url: string) {
      const { client: cdp } = requireConnected();
      /**
       * 已经在那一页就别再导航一次：面板里显示的就是这一页，重来一次 `Page.navigate`
       * 会整页重载——页面里已经填的东西、控制台里敲过的东西全没了。
       */
      const current = state.status === "connected" ? state.currentUrl : "";
      if (!samePageUrl(current, url)) {
        await session.navigate(url);
      }
      await closeIdleBlanks(cdp);
      const sessionId = requireConnected().sessionId;
      const script = await debugConsole.script();
      /**
       * 注入 Eruda（页面内调试控制台：Console / Elements / Network / Storage / Info）。
       * **整段源码直投**，而不是往页面里插 `<script src=…>`——页面侧加载会静默失败
       * （真机撞到过：注入报成功、页面上什么都没有），原因与取舍见 debug-console 模块头注。
       */
      const evaluated = (await cdp.send(
        "Runtime.evaluate",
        { expression: script, awaitPromise: false },
        sessionId,
      )) as {
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      };
      if (evaluated.exceptionDetails) {
        throw new CdpError(
          "command_failed",
          `注入调试控制台时页面报错：${
            evaluated.exceptionDetails.exception?.description ??
            evaluated.exceptionDetails.text ??
            "未知错误"
          }`,
        );
      }
      // 自检：脚本真的生效了吗（否则界面说成功、用户看着「点了没反应」）
      const probe = (await cdp.send(
        "Runtime.evaluate",
        { expression: DEBUG_CONSOLE_PROBE, returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown } };
      const probed = parseDebugConsoleProbe(probe.result?.value);
      if (!probed.initialized) {
        console.warn(
          "[browser] 调试控制台自检没通过：",
          JSON.stringify(probed).slice(0, 400),
        );
        throw new CdpError(
          "command_failed",
          `调试控制台没能在这个页面里生效${
            probed.error
              ? `：${probed.error}`
              : probed.loaded
                ? "（脚本注进去了但启动失败）。"
                : "（页面里拿不到 eruda，可能被这一页拦住了）。"
          }`,
        );
      }
      return { url };
    },

    async disconnect() {
      offNavigation?.();
      offNavigation = null;
      client?.close();
      client = null;
      sessionId = null;
      const pid = child?.pid;
      child = null;
      if (pid) {
        // 自己起的实例：整棵进程树收掉（Windows 上 kill 只杀外壳那条老坑）
        if (process.platform === "win32") {
          const { spawn } = await import("node:child_process");
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // 已经没了
          }
        }
      }
      state = { status: "disconnected" };
      return state;
    },
    async navigate(url) {
      const { client: cdp } = requireConnected();
      const id = await ensureTab(cdp, url);
      // 已经导航到目标页了：顺手把连接时留下的空白标签收掉（否则窗口里会多一个 about:blank）
      await closeIdleBlanks(cdp);
      const dom = await readDom(cdp, id);
      // 视口尺寸用于截图元信息（拿不到就用默认）
      try {
        const metrics = (await cdp.send("Page.getLayoutMetrics", {}, id)) as {
          cssVisualViewport?: { clientWidth: number; clientHeight: number };
        };
        if (metrics.cssVisualViewport) {
          portrait = {
            width: Math.round(metrics.cssVisualViewport.clientWidth),
            height: Math.round(metrics.cssVisualViewport.clientHeight),
          };
        }
      } catch {
        // 拿不到不影响主流程
      }
      if (state.status === "connected") {
        state = { ...state, currentUrl: dom.url };
      }
      return dom;
    },
    async snapshot() {
      const { client: cdp, sessionId: id } = requireConnected();
      return readDom(cdp, id);
    },
    async pickables() {
      const { client: cdp, sessionId: id } = requireConnected();
      const page = await readPickables(cdp, id);
      // 截图与几何用同一套视口坐标（readPickables 已把页面滚到顶）：
      // 截图的宽高直接取 CDP 的视口尺寸，不靠 portrait 缓存，避免两者错位
      const shot = await captureAndUpload(cdp, id).catch(() => null);
      return {
        ...page,
        ...(shot ? { screenshotUrl: shot.screenshotUrl } : {}),
      };
    },
    async screenshot() {
      const { client: cdp, sessionId: id } = requireConnected();
      return captureAndUpload(cdp, id);
    },
    async click(target) {
      const { client: cdp, sessionId: id } = requireConnected();
      await clickOn(cdp, id, target);
    },
    async type(text) {
      const { client: cdp, sessionId: id } = requireConnected();
      await typeText(cdp, id, text);
    },
    async key(key) {
      const { client: cdp, sessionId: id } = requireConnected();
      await pressKey(cdp, id, key);
    },
    async viewport() {
      const { client: cdp, sessionId: id } = requireConnected();
      return readViewport(cdp, id);
    },
    async resize(size) {
      const { client: cdp, sessionId: id } = requireConnected();
      await setViewportOverride(cdp, id, size);
    },
    async input(event) {
      const { client: cdp, sessionId: id } = requireConnected();
      if (event.type === "mouse") {
        await dispatchMouse(cdp, id, {
          type:
            event.action === "pressed"
              ? "mousePressed"
              : event.action === "released"
                ? "mouseReleased"
                : "mouseMoved",
          x: event.x,
          y: event.y,
          ...(event.button ? { button: event.button } : {}),
          ...(typeof event.buttons === "number"
            ? { buttons: event.buttons }
            : {}),
          ...(typeof event.modifiers === "number"
            ? { modifiers: event.modifiers }
            : {}),
        });
        return;
      }
      if (event.type === "wheel") {
        await dispatchWheel(cdp, id, event);
        return;
      }
      if (event.type === "key") {
        await dispatchKey(cdp, id, event);
        return;
      }
      await typeText(cdp, id, event.text);
    },
    async watch(options, onFrame) {
      const { client: cdp, sessionId: id } = requireConnected();
      // 同时只留一个画面订阅者：面板重连时旧响应可能还没断干净，
      // 两个订阅者会把每帧都发两遍（流量翻倍），也会多 ack 一次。
      await activeWatcher?.().catch(() => undefined);
      // 「自由尺寸」= 真的改视口（不是把图缩小），关掉时还原窗口尺寸
      const size =
        options.width && options.height
          ? { width: options.width, height: options.height }
          : null;
      await setViewportOverride(cdp, id, size);
      await startScreencast(cdp, id, {
        ...(options.width ? { maxWidth: options.width } : {}),
        ...(options.height ? { maxHeight: options.height } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
      });
      const off = cdp.on("Page.screencastFrame", (params, eventSessionId) => {
        // 别的标签的帧不要（事件按 CDP 会话分发，我们的页面是当前会话）
        if (eventSessionId && eventSessionId !== id) return;
        const data = typeof params.data === "string" ? params.data : "";
        const frameId = Number(params.sessionId);
        void (async () => {
          if (data) {
            // 写完（发出去）再 ack：Chrome 以 ack 做背压，先 ack 会堆帧
            await Promise.resolve(onFrame(Buffer.from(data, "base64"))).catch(
              () => undefined,
            );
          }
          if (Number.isFinite(frameId)) {
            await ackScreencastFrame(cdp, id, frameId);
          }
        })();
      });
      const stop = async () => {
        off();
        if (activeWatcher === stop) activeWatcher = null;
        await stopScreencast(cdp, id).catch(() => undefined);
        await setViewportOverride(cdp, id, null).catch(() => undefined);
      };
      activeWatcher = stop;
      return stop;
    },
    async listTabs() {
      const { client: cdp } = requireConnected();
      const tabs = await cdp.listTargets();
      return tabs.map((tab) => ({ url: tab.url, title: tab.title }));
    },
  };
  return session;
}
