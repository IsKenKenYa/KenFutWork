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
  type ConsoleMessage,
  createConsoleBuffer,
  formatConsoleCall,
  formatEvalResult,
  formatExceptionThrown,
  formatLogEntry,
} from "./console-log.js";
import {
  createDebugConsoleSource,
  DEBUG_CONSOLE_PROBE,
  type DebugConsoleSource,
  parseDebugConsoleProbe,
} from "./debug-console.js";
import { sendDevToolsKey } from "./devtools-keys.js";
import {
  capBody,
  createNetworkBuffer,
  isTextMime,
  type NetworkRequest,
  RESPONSE_BODY_MAX_BYTES,
} from "./network-log.js";
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
   * **注入页面内调试控制台**（Eruda，现成第三方）到受控页面，并把它摆成**悬浮窗**
   * （可拖动 / 可关闭；形态改造见 debug-console 的 FLOAT_SCRIPT）。
   *
   * 用户口径：「之前用的不是参考别人的控制台吗」——所以这里就是那个 Eruda，不自己重写。
   */
  injectDebugConsole(url: string): Promise<{ url: string }>;
  /** 调试控制台脚本源码（桌面形态 eval 进子 webview 用同一份）。 */
  debugConsoleScript(): Promise<string>;
  /**
   * 在**受控浏览器**里打开完整开发者工具，并取消停靠成**独立窗口**（浮动、可移动）。
   *
   * 做法与取舍见 `devtools-keys` 头注：真 DevTools 只有浏览器自己开得出来（CDP 开出来的
   * devtools:// 窗口没有前端桥，只会显示「调试连接已关闭」）。所以这里「像人一样」：
   * 激活受控窗口 → F12 → 给刚开出来的 DevTools 发 `setIsDocked(false)` → 摆位置。
   */
  openDevToolsWindow(options?: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
  }): Promise<{
    windowId: number;
    bounds: { left: number; top: number; width: number; height: number };
  }>;
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
  /**
   * 悬浮控制台的消息（增量）：`since` = 客户端已经拿到的最大 seq。
   *
   * 消息来自页面里的 `console.*`、未捕获异常、浏览器日志——在**打标签时就订阅**了，
   * 所以「打开控制台之前就报的错」也在（否则用户先看到页面报错、再开控制台却什么都没有）。
   */
  messages(
    since: number,
  ): Promise<{ messages: ConsoleMessage[]; nextSeq: number }>;
  /** 悬浮控制台里敲的表达式：在页面里执行并回一行结果（对象给一行预览）。 */
  evaluate(expression: string): Promise<ConsoleMessage>;
  /**
   * 在页面里执行一段 JS，回**结构化结果**（`browser_eval` 用；与 `evaluate` 的区别：
   * 那个折成一行进控制台时间线给人看，这个把原始值/类型原样回给 agent 做判断）。
   *
   * `returnByValue` 拿可序列化的值；拿不到（函数/DOM 节点这类）时回一段预览文本。
   * 抛错时不进控制台缓冲，直接把异常文本回给调用方（它要的是「这段代码行不行」）。
   */
  evaluateValue(expression: string): Promise<{
    ok: boolean;
    /** 成功时的值（returnByValue 拿到；拿不到时是预览字符串）。 */
    value?: unknown;
    /** 值类型（string/number/boolean/object/undefined…）。 */
    type?: string;
    /** 失败时的异常文本。 */
    error?: string;
  }>;
  /** 清空控制台缓存（界面上的「清空」）。 */
  clearMessages(): Promise<void>;
  /**
   * 面板采集到的**网络请求**（增量，同 `messages`）——agent 用它判断「点了那个按钮有没有真的发请求、
   * 回来多少」。数据面见 network-log。
   */
  requests(
    since: number,
  ): Promise<{ requests: NetworkRequest[]; nextSeq: number }>;
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
  /** 测试注入：时间来源（控制台消息的时间戳）。 */
  now?: () => Date;
  /** 测试注入：在受控窗口里按 F12（默认走平台脚本）。 */
  sendKeys?: typeof sendDevToolsKey;
  /** 测试注入：页面内调试控制台（Eruda）脚本来源（默认从 CDN 取一次并缓存）。 */
  debugConsole?: DebugConsoleSource;
}): CdpBrowserSession {
  const dataDir = deps.dataDir ?? join(tmpdir(), "kenfutwork-chrome-profile");

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
  /** 页面事件订阅（导航 + 控制台；退订用，见 `attachPageTracking`）。 */
  let pageListeners: Array<() => void> = [];
  /** 悬浮控制台的消息缓存（环形，见 console-log）。 */
  const consoleLog = createConsoleBuffer();
  /** 网络请求缓存（环形，见 network-log）。 */
  const networkLog = createNetworkBuffer();
  /**
   * requestId → 发起时刻（CDP 单调秒）。用来算耗时（发出 → 完成）；
   * 完成/失败即删，断开时整体清（不给 CDP 的内部 id 留长期状态）。
   */
  const networkStartedAt = new Map<string, number>();
  /** 时间戳来源（测试注入，默认 Date）。 */
  const now = deps.now ?? (() => new Date());
  const sendKeys = deps.sendKeys ?? sendDevToolsKey;
  const debugConsole = deps.debugConsole ?? createDebugConsoleSource();

  /**
   * 挂上页面级事件：**导航跟踪** + **控制台消息**。
   *
   * - 导航：`currentUrl` 原先只在 `navigate()` 里更新，页面自己跳走（点链接）后状态会停在旧地址
   *   （真机实测撞上：画面已是新页、`status()` 还报旧页，「是不是同一页」的判断跟着错）；
   * - 控制台：在**打标签时就订阅**，所以「打开控制台之前页面就报的错」也在——
   *   不然用户先看到页面报错、再打开控制台却什么都没有。
   *
   * 三个域 enable 失败不影响主流程（有些页面会拦），订阅照挂。
   */
  const attachPageTracking = (target: CdpClient, id: string): void => {
    if (pageListeners.length > 0) return;
    for (const domain of ["Page", "Runtime", "Log", "Network"]) {
      void target.send(`${domain}.enable`, {}, id).catch(() => undefined);
    }
    /** 只认我们这个会话的事件（别的标签的不要）。 */
    const mine = (eventSessionId: string | undefined): boolean =>
      !eventSessionId || eventSessionId === id;
    pageListeners = [
      target.on("Page.frameNavigated", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        const frame = params.frame as
          | { url?: unknown; parentId?: unknown }
          | undefined;
        const url = typeof frame?.url === "string" ? frame.url : "";
        // 只认主框架：子框架（iframe）自己跳走不该改「当前页」
        if (!url || typeof frame?.parentId === "string") return;
        if (state.status === "connected") {
          state = { ...state, currentUrl: url };
        }
      }),
      target.on("Runtime.consoleAPICalled", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        consoleLog.push(
          formatConsoleCall(params as never, now().toISOString()),
        );
      }),
      target.on("Runtime.exceptionThrown", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        consoleLog.push(
          formatExceptionThrown(params as never, now().toISOString()),
        );
      }),
      target.on("Log.entryAdded", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        consoleLog.push(formatLogEntry(params as never, now().toISOString()));
      }),
      // 网络：发出 → 响应 / 完成 / 失败（同一条记录就地补状态，seq 在「发出」时定）
      target.on("Network.requestWillBeSent", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        const requestId =
          typeof params.requestId === "string" ? params.requestId : "";
        const request = params.request as
          | { url?: unknown; method?: unknown; postData?: unknown }
          | undefined;
        if (!requestId) return;
        if (typeof params.timestamp === "number") {
          networkStartedAt.set(requestId, params.timestamp);
        }
        networkLog.started(requestId, {
          method: typeof request?.method === "string" ? request.method : "GET",
          url: typeof request?.url === "string" ? request.url : "",
          ...(typeof params.type === "string" ? { type: params.type } : {}),
          // 请求体：事件里带 postData 才采（表单/JSON 提交）；大体积同样截断
          ...(typeof request?.postData === "string" && request.postData
            ? { requestBody: capBody(request.postData) }
            : {}),
          at: now().toISOString(),
        });
      }),
      target.on("Network.responseReceived", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        const requestId =
          typeof params.requestId === "string" ? params.requestId : "";
        const response = params.response as
          | { status?: unknown; mimeType?: unknown }
          | undefined;
        const status =
          typeof response?.status === "number" ? response.status : 0;
        if (requestId && status > 0) {
          networkLog.responded(requestId, status, {
            ...(typeof response?.mimeType === "string"
              ? { mimeType: response.mimeType }
              : {}),
          });
        }
      }),
      target.on("Network.loadingFinished", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        const requestId =
          typeof params.requestId === "string" ? params.requestId : "";
        if (!requestId) return;
        const startedAt = networkStartedAt.get(requestId);
        networkStartedAt.delete(requestId);
        const finishedAt =
          typeof params.timestamp === "number" ? params.timestamp : undefined;
        const durationMs =
          startedAt !== undefined && finishedAt !== undefined
            ? Math.max(0, Math.round((finishedAt - startedAt) * 1000))
            : undefined;
        /**
         * 响应体按需取：只有文本类 MIME 且体积在上限内才要（二进制取回来是乱码，
         * 大响应会把内存与 agent 的结果一起撑爆）。取体失败（重定向 / 无体 / 已被
         * 丢弃）不是错误路径——照样把耗时补上。
         */
        void (async () => {
          let responseBody: string | undefined;
          const current = networkLog.get(requestId);
          const encoded =
            typeof params.encodedDataLength === "number"
              ? params.encodedDataLength
              : 0;
          if (
            current &&
            isTextMime(current.mimeType) &&
            encoded <= RESPONSE_BODY_MAX_BYTES
          ) {
            try {
              const { client: cdp, sessionId: id } = requireConnected();
              const body = (await cdp.send(
                "Network.getResponseBody",
                { requestId },
                id,
              )) as { body?: unknown; base64Encoded?: unknown };
              if (
                typeof body?.body === "string" &&
                body.base64Encoded !== true
              ) {
                responseBody = capBody(body.body);
              }
            } catch {
              // 取不到就算了（重定向、无响应体、已被浏览器丢弃）
            }
          }
          if (durationMs !== undefined || responseBody !== undefined) {
            networkLog.finished(requestId, durationMs ?? 0, responseBody);
          }
        })();
      }),
      target.on("Network.loadingFailed", (params, eventSessionId) => {
        if (!mine(eventSessionId)) return;
        const requestId =
          typeof params.requestId === "string" ? params.requestId : "";
        if (!requestId) return;
        networkStartedAt.delete(requestId);
        const reason =
          typeof params.errorText === "string" ? params.errorText : "请求失败";
        networkLog.failed(
          requestId,
          typeof params.blockedReason === "string"
            ? `${reason}（被拦：${params.blockedReason}）`
            : reason,
        );
      }),
    ];
  };

  /** 退订页面事件（换标签 / 断开时）。 */
  const detachPageTracking = (): void => {
    for (const off of pageListeners) off();
    pageListeners = [];
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
    attachPageTracking(target, opened.sessionId);
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
        // 新客户端：旧的订阅句柄作废（否则 attachPageTracking 会以为已经订阅过）
        detachPageTracking();
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
    async messages(since) {
      return {
        messages: consoleLog.since(since),
        nextSeq: consoleLog.latestSeq(),
      };
    },
    async clearMessages() {
      consoleLog.clear();
      networkLog.clear();
      networkStartedAt.clear();
    },
    async requests(since) {
      return {
        requests: networkLog.since(since),
        nextSeq: networkLog.latestSeq(),
      };
    },
    async evaluate(expression) {
      const { client: cdp, sessionId: id } = requireConnected();
      const evaluated = (await cdp.send(
        "Runtime.evaluate",
        {
          expression,
          // 对象也给点信息：一行预览（否则只能看到 "Object"）
          generatePreview: true,
          awaitPromise: true,
          userGesture: true,
        },
        id,
      )) as never;
      // 自己敲的也进同一条时间线（下次增量拉取时顺序一致）
      return consoleLog.push(formatEvalResult(evaluated, now().toISOString()));
    },
    async evaluateValue(expression) {
      const { client: cdp, sessionId: id } = requireConnected();
      const evaluated = (await cdp.send(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        id,
      )) as {
        result?: { type?: string; value?: unknown; description?: string };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      };
      if (evaluated.exceptionDetails) {
        return {
          ok: false,
          error:
            evaluated.exceptionDetails.exception?.description ??
            evaluated.exceptionDetails.text ??
            "执行出错",
        };
      }
      const result = evaluated.result;
      // 值拿不到（函数 / DOM 节点 / 含不可序列化内容）时 CDP 只给 description：用预览兜底，
      // 不让 agent 拿到空 value 误以为「返回了 undefined」。
      const hasValue = result !== undefined && "value" in result;
      return {
        ok: true,
        value: hasValue ? result.value : (result?.description ?? null),
        type: result?.type ?? (hasValue ? typeof result.value : "object"),
      };
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
      // 整段源码直投（含 UMD 分支修正与悬浮窗改造），见 debug-console 头注
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
    async debugConsoleScript() {
      return debugConsole.script();
    },
    async openDevToolsWindow(options = {}) {
      const { client: cdp, sessionId: id } = requireConnected();
      if (state.status === "connected" && state.headless) {
        throw new CdpError(
          "command_failed",
          "开发者工具需要一个可见的浏览器窗口：当前连的是无头实例。到「设置 → 浏览器」关掉「无头浏览器」并重新连接后再试。",
        );
      }
      // 受控窗口的标题就是当前页面标题：按键脚本按它找窗口
      const dom = await readDom(cdp, id).catch(() => null);
      const title = (dom?.title ?? "").trim();
      if (!title) {
        throw new CdpError(
          "command_failed",
          "拿不到受控浏览器当前页面的标题，没法定位它的窗口——先在面板里打开一个网址再试。",
        );
      }
      const findDevTools = async (): Promise<
        { targetId: string; url: string; title: string } | undefined
      > => {
        const targets = await cdp.listTargets();
        return targets.find((target) =>
          target.url.includes("devtools_app.html"),
        );
      };
      let devtools = await findDevTools();
      if (!devtools) {
        await sendKeys(title);
        // 等浏览器把它开出来（最多 10 秒）
        for (let attempt = 0; attempt < 20 && !devtools; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          devtools = await findDevTools();
        }
      }
      if (!devtools) {
        throw new CdpError(
          "command_failed",
          "没能在受控浏览器窗口里唤起开发者工具：请在那个窗口里按 F12（或右键 → 检查），再点一次这个按钮。",
        );
      }
      // 取消停靠 → 独立窗口（走 DevTools 前端的桥，只有浏览器自己开的实例才有）
      const attached = (await cdp.send("Target.attachToTarget", {
        targetId: devtools.targetId,
        flatten: true,
      })) as { sessionId?: string };
      if (attached.sessionId) {
        await cdp
          .send(
            "Runtime.evaluate",
            {
              expression:
                "typeof InspectorFrontendHost !== 'undefined' && InspectorFrontendHost.setIsDocked(false)",
            },
            attached.sessionId,
          )
          .catch(() => undefined);
      }
      // 等它真的独立出去（窗口宽度变成 DevTools 自己的），再摆位置
      let windowId = 0;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const fresh = (await cdp.send("Browser.getWindowForTarget", {
          targetId: devtools.targetId,
        })) as { windowId?: number; bounds?: { width?: number } };
        windowId = fresh.windowId ?? windowId;
        const width = fresh.bounds?.width ?? 0;
        if (windowId && width > 0 && width < 1100) break;
      }
      const bounds = {
        left: options.left ?? 60,
        top: options.top ?? 60,
        width: options.width ?? 1280,
        height: options.height ?? 860,
      };
      if (windowId) {
        await cdp
          .send("Browser.setWindowBounds", {
            windowId,
            bounds: { ...bounds, windowState: "normal" },
          })
          .catch(() => undefined);
      }
      return { windowId, bounds };
    },
    async disconnect() {
      detachPageTracking();
      networkStartedAt.clear();
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
