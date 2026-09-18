import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BlobStore } from "../blob/types.js";
import {
  type CdpClient,
  CdpError,
  captureScreenshot,
  clickOn,
  connectCdpClient,
  findBrowserExecutable,
  launchBrowserWithDebugPort,
  pressKey,
  readDom,
  readPickables,
  typeText,
  waitForDevtools,
  waitForLoad,
} from "./cdp-client.js";

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
   * 给**受控浏览器的当前页面**打开真 DevTools（在受控浏览器里开一个调试前端标签）。
   *
   * 为什么是这条路：面板里的页面挂在 iframe 上，浏览器不允许给 iframe 单独挂调试器；
   * 受控浏览器那边是**真标签**，`devtools://devtools/bundled/inspector.html?ws=<页面调试地址>`
   * 就是 Chrome 认的调试前端地址——开出来就是能用的 DOM/网络/控制台面板。
   */
  openDevtools(): Promise<{ targetId: string; url: string }>;
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
  listTabs(): Promise<Array<{ url: string; title: string }>>;
  /** 会话是否可用（工具与端点在调用前判）。 */
  isConnected(): boolean;
}

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
    async openDevtools() {
      const { client: cdp } = requireConnected();
      const targets = await cdp.listPageTargetsWithDebugUrl();
      /**
       * 挑哪一块页面：优先与**当前页面**同址的那块；否则第一块非空白的普通页。
       * （受控浏览器里可能还开着别的标签，挑错就等于调试另一个页面。）
       */
      const current = state.status === "connected" ? state.currentUrl : "";
      const page =
        targets.find((entry) => entry.url === current) ??
        targets.find((entry) => entry.url.startsWith("http")) ??
        targets[0];
      if (!page) {
        throw new CdpError(
          "cdp_no_page",
          "受控浏览器里没有可调试的页面：先在右栏浏览器打开一个网址。",
        );
      }
      if (!page.webSocketDebuggerUrl) {
        throw new CdpError(
          "cdp_no_debug_url",
          "拿不到这块页面的调试地址（浏览器可能不允许远程调试）。",
        );
      }
      const url = `devtools://devtools/bundled/inspector.html?ws=${encodeURIComponent(
        page.webSocketDebuggerUrl,
      )}`;
      const created = (await cdp.send("Target.createTarget", { url })) as {
        targetId?: string;
      };
      return { targetId: created.targetId ?? "", url: page.url };
    },

    async disconnect() {
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
    async listTabs() {
      const { client: cdp } = requireConnected();
      const tabs = await cdp.listTargets();
      return tabs.map((tab) => ({ url: tab.url, title: tab.title }));
    },
  };
  return session;
}
