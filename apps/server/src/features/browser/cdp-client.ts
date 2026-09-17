import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import WebSocket from "ws";

/**
 * 极简 CDP 客户端（R5-4「连接到 Chrome」+「自动截图」的执行面）。
 *
 * **为什么是 CDP 而不是浏览器扩展**：扩展要用户手动装、还要维护 manifest 与商店分发；
 * 而 Chrome/Edge 自带 `--remote-debugging-port`——用**独立 profile** 启动一个受我们控制的
 * 浏览器实例，就能拿到真实的渲染后 DOM、截图、点击与输入。设置页把这条路径如实写给用户：
 * 连接会**另起一个浏览器实例**（专用 profile，不动你日常那个窗口）。
 *
 * 依赖面：零新增——用 Node 的 `fetch` 打 `/json/version` 拿 WebSocket 地址，用已有依赖
 * `ws` 收发 CDP 消息（CDP 就是 JSON over WS）。
 */

export interface CdpVersion {
  browser: string;
  protocolVersion: string;
  webSocketDebuggerUrl: string;
}

export class CdpError extends Error {
  readonly code:
    | "chrome_not_found"
    | "launch_failed"
    | "connect_failed"
    | "command_failed";
  constructor(code: CdpError["code"], message: string) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

/** 常见安装位置（可用 `KENFUTWORK_CHROME_PATH` 覆盖）。 */
export function findBrowserExecutable(
  explicit?: string | undefined,
): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  const envPath = process.env.KENFUTWORK_CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
      candidates.push(
        join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  executable: string;
  port: number;
  profileDir: string;
}

/**
 * 用调试端口启动一个**独立实例**（专用 profile）。
 *
 * 独立 profile 是必须的：已经运行的 Chrome 会忽略 `--remote-debugging-port`，
 * 拿不到调试端口（那种情况下用户看到的「连接失败」其实就是这个原因，报错文案里写清）。
 */
export async function launchBrowserWithDebugPort(options: {
  executable: string;
  port: number;
  profileDir: string;
  headless?: boolean;
  initialUrl?: string;
}): Promise<LaunchedBrowser> {
  await mkdir(options.profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(options.headless ? ["--headless=new"] : []),
    options.initialUrl ?? "about:blank",
  ];
  try {
    const child = spawn(options.executable, args, {
      windowsHide: true,
      stdio: "ignore",
      detached: false,
    });
    return {
      child,
      executable: options.executable,
      port: options.port,
      profileDir: options.profileDir,
    };
  } catch (error) {
    throw new CdpError(
      "launch_failed",
      `启动浏览器失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 等 DevTools 端口就绪（Chrome 起进程到监听有一点延迟）。 */
export async function waitForDevtools(
  port: number,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CdpVersion> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        /**
         * 字段名按 **Chrome 的原样输出**读（`Browser` / `Protocol-Version` 首字母大写）。
         * 直接把它当 `CdpVersion` 用会让 `browser` 恒为 undefined——真机实测：设置页
         * 「连接到 Chrome」状态里的浏览器名一直是空的。这里显式映射，并兼容驼峰写法。
         */
        const raw = (await response.json()) as {
          Browser?: string;
          "Protocol-Version"?: string;
          browser?: string;
          protocolVersion?: string;
          webSocketDebuggerUrl?: string;
        };
        if (raw.webSocketDebuggerUrl) {
          return {
            browser: raw.Browser ?? raw.browser ?? "未知浏览器",
            protocolVersion:
              raw["Protocol-Version"] ?? raw.protocolVersion ?? "",
            webSocketDebuggerUrl: raw.webSocketDebuggerUrl,
          };
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new CdpError(
    "connect_failed",
    `连不上浏览器调试端口 ${port}（${lastError}）。若目标浏览器已经在运行，请先退出它——` +
      "已运行的实例会忽略调试端口参数；本功能用的是独立 profile 的新实例。",
  );
}

export interface CdpSessionTarget {
  targetId: string;
  sessionId: string;
}

export interface CdpClient {
  /** 原始命令（高级用法/测试）。 */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** 开一个标签并附着（返回可用的 sessionId）。 */
  openTab(url: string): Promise<CdpSessionTarget>;
  listTargets(): Promise<
    Array<{ targetId: string; url: string; title: string }>
  >;
  closeTab(targetId: string): Promise<void>;
  close(): void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 连上 DevTools WebSocket，得到可发命令的客户端（带每命令超时与错误折叠）。 */
export function connectCdpClient(
  wsUrl: string,
  options: { commandTimeoutMs?: number } = {},
): CdpClient {
  const commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;

  socket.on("message", (raw) => {
    let message: {
      id?: number;
      error?: { message?: string };
      result?: unknown;
    };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new CdpError("command_failed", message.error.message ?? "CDP 命令失败"),
      );
      return;
    }
    entry.resolve((message.result ?? {}) as Record<string, unknown>);
  });

  const failAll = (reason: string) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new CdpError("connect_failed", reason));
    }
  };
  socket.on("close", () => {
    closed = true;
    failAll("调试连接已断开（浏览器被关闭或断开连接）");
  });
  socket.on("error", (error) => {
    failAll(
      `调试连接出错：${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const waitOpen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CdpError("connect_failed", "调试连接超时")),
      commandTimeoutMs,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new CdpError(
          "connect_failed",
          `调试连接失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });

  const send = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    await waitOpen;
    if (closed) throw new CdpError("connect_failed", "调试连接已关闭");
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpError("command_failed", `${method} 超时`));
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  };

  return {
    send,
    async openTab(url) {
      const created = (await send("Target.createTarget", { url })) as {
        targetId?: string;
      };
      if (!created.targetId) {
        throw new CdpError("command_failed", "开标签没有拿到 targetId");
      }
      const attached = (await send("Target.attachToTarget", {
        targetId: created.targetId,
        flatten: true,
      })) as { sessionId?: string };
      if (!attached.sessionId) {
        throw new CdpError("command_failed", "附着标签没有拿到 sessionId");
      }
      return { targetId: created.targetId, sessionId: attached.sessionId };
    },
    async listTargets() {
      const result = (await send("Target.getTargets")) as {
        targetInfos?: Array<{
          targetId: string;
          type: string;
          url: string;
          title: string;
        }>;
      };
      return (result.targetInfos ?? [])
        .filter((info) => info.type === "page")
        .map((info) => ({
          targetId: info.targetId,
          url: info.url,
          title: info.title,
        }));
    },
    async closeTab(targetId) {
      await send("Target.closeTarget", { targetId });
    },
    close() {
      closed = true;
      failAll("客户端已关闭");
      try {
        socket.close();
      } catch {
        // 关不上就算了（进程退出时会一起没）
      }
    },
  };
}

/** 等页面加载完成（用 load 事件；超时按「先继续」处理，很多站点有长轮询）。 */
export async function waitForLoad(
  client: CdpClient,
  sessionId: string,
  timeoutMs = 15_000,
): Promise<void> {
  await client.send("Page.enable", {}, sessionId).catch(() => undefined);
  await client
    .send(
      "Runtime.evaluate",
      {
        expression: `new Promise((resolve) => {
          if (document.readyState === "complete") return resolve(1);
          window.addEventListener("load", () => resolve(1), { once: true });
          setTimeout(() => resolve(1), ${Math.max(1000, timeoutMs - 1000)});
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => undefined);
}

/** 真实 DOM 读取：标题 / 正文 / 可交互元素（跨源、登录态页面都能拿到）。 */
export async function readDom(
  client: CdpClient,
  sessionId: string,
): Promise<{
  url: string;
  title: string;
  text: string;
  elements: Array<{ tag: string; text: string; hint: string }>;
}> {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const clean = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
        const hintFor = (el) => {
          if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
          const tag = el.tagName.toLowerCase();
          if (el.getAttribute && el.getAttribute("name")) return tag + '[name="' + el.getAttribute("name") + '"]';
          if (el.getAttribute && el.getAttribute("href")) return tag + '[href^="' + String(el.getAttribute("href")).slice(0, 60) + '"]';
          return tag;
        };
        const elements = [];
        const push = (el) => {
          if (elements.length >= 60) return;
          const tag = el.tagName.toLowerCase();
          let text = clean(el.innerText || el.textContent);
          if (!text && tag === "input") text = el.placeholder || el.name || "(" + (el.type || "text") + ")";
          if (!text && tag === "img") text = el.alt || "(图片)";
          if (!text) return;
          elements.push({ tag, text, hint: hintFor(el) });
        };
        document.querySelectorAll("h1,h2,h3,a,button,input,textarea,select,img[alt]").forEach(push);
        return JSON.stringify({
          url: location.href,
          title: document.title,
          text: clean(document.body ? document.body.innerText : "").slice(0, 4000),
          elements,
        });
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  const value = (result as { result?: { value?: string } }).result?.value;
  if (typeof value !== "string") {
    throw new CdpError("command_failed", "读取页面 DOM 失败");
  }
  return JSON.parse(value) as {
    url: string;
    title: string;
    text: string;
    elements: Array<{ tag: string; text: string; hint: string }>;
  };
}

/** 截图（PNG bytes）。 */
export async function captureScreenshot(
  client: CdpClient,
  sessionId: string,
): Promise<Uint8Array> {
  const result = (await client.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId,
  )) as { data?: string };
  if (!result.data) {
    throw new CdpError("command_failed", "截图没有返回数据");
  }
  return Buffer.from(result.data, "base64");
}

/** 点击：优先选择器（在页面里算中心点），也支持直接给坐标。 */
export async function clickOn(
  client: CdpClient,
  sessionId: string,
  target: { selector?: string; x?: number; y?: number },
): Promise<void> {
  let { x, y } = target;
  if (typeof x !== "number" || typeof y !== "number") {
    const selector = target.selector ?? "";
    if (!selector) {
      throw new CdpError("command_failed", "点击需要 selector 或坐标");
    }
    const found = (await client.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const rect = el.getBoundingClientRect();
          return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        })()`,
        returnByValue: true,
      },
      sessionId,
    )) as { result?: { value?: string | null } };
    const value = found.result?.value;
    if (!value) {
      throw new CdpError("command_failed", `页面上找不到 ${selector}`);
    }
    ({ x, y } = JSON.parse(value) as { x: number; y: number });
  }
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await client.send(
      "Input.dispatchMouseEvent",
      { type, x, y, button: "left", clickCount: 1 },
      sessionId,
    );
  }
}

/** 在当前焦点输入文本（先点一下目标元素更稳，见 clickOn）。 */
export async function typeText(
  client: CdpClient,
  sessionId: string,
  text: string,
): Promise<void> {
  await client.send("Input.insertText", { text }, sessionId);
}

/** 按键（如 Enter / Tab / Escape，也接受单字符）。 */
export async function pressKey(
  client: CdpClient,
  sessionId: string,
  key: string,
): Promise<void> {
  const isNamed = key.length > 1;
  const code = isNamed ? key : `Key${key.toUpperCase()}`;
  const base: Record<string, unknown> = {
    key,
    code,
    windowsVirtualKeyCode: isNamed
      ? keyCodeFor(key)
      : key.toUpperCase().charCodeAt(0),
  };
  await client.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", ...base },
    sessionId,
  );
  await client.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...base },
    sessionId,
  );
}

function keyCodeFor(key: string): number {
  const map: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    " ": 32,
  };
  return map[key] ?? 0;
}
