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
    // 我们收残留实例是**强杀**（Chrome 对同一 profile 只许一个进程），下次启动会弹
    //「要恢复页面吗？Chrome 未正确关闭」——这条把它压掉（真机截图里就是那个弹窗）
    "--hide-crash-restore-bubble",
    "--disable-features=Translate",
    /**
     * **必须开**：Chrome 111+ 对带 Origin 的调试 WebSocket 做白名单校验，而 DevTools 前端
     * （`devtools://devtools/...`）正是这么连的——不开的话前端打开后会立刻
     * 「Debugging connection was closed / WebSocket disconnected」（真机踩到，截图就是这句）。
     * 这个实例是我们用**独立 profile** 起的本地调试实例，放开 Origin 的影响面仅限它。
     */
    "--remote-allow-origins=*",
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
/**
 * 收掉「用着我们自己 profile 的残留实例」。
 *
 * **真机踩到的坑**：修复（给启动参数加 `--remote-allow-origins`）之后用户那边仍然连不上——
 * 因为**旧的 Chrome 进程还活着**（用着同一个 `--user-data-dir`），新的一次启动会「交棒」给
 * 它并立刻退出，于是**参数永远加不上**，调试前端打开后立刻断（界面显示「调试连接已关闭」）。
 *
 * 只动**命令行里带我们 profile 目录**的进程：用户自己日常开的 Chrome 用的不是这个 profile，
 * 不会被碰到。收完等端口空出来（最多 5 秒）再让调用方启动新的。
 */
export async function killStaleProfileInstance(
  profileDir: string,
  port: number,
): Promise<boolean> {
  const answering = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((response) => response.ok)
    .catch(() => false);
  if (!answering) return false;

  if (process.platform === "win32") {
    /**
     * 按命令行匹配（我们自己的 profile 路径唯一）→ 收掉整棵进程树。
     * 注意：这一段是嵌在 PowerShell **单引号字符串**里的，反斜杠在那里就是字面量，
     * **不能**再重复转义——真机踩过：重复转义后 `-like` 匹配不上，残留实例纹丝不动。
     */
    const pattern = profileDir;
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else {
    await new Promise<void>((resolve) => {
      const killer = spawn("pkill", ["-f", profileDir], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  }

  // 等端口释放（最多 5 秒），免得紧接着的启动又交棒给还没退干净的旧进程
  for (let i = 0; i < 20; i += 1) {
    const stillAlive = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (!stillAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

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
  /**
   * 订阅 CDP **事件**（`method` 全名，如 `Page.screencastFrame`）；返回退订函数。
   *
   * 面板内实时视图要靠它：画面帧是事件推过来的（不是命令的返回值）。
   * 订阅者抛错被吞掉——一个订阅者出错不该影响命令通道。
   */
  on(
    method: string,
    handler: (
      params: Record<string, unknown>,
      sessionId?: string | undefined,
    ) => void,
  ): () => void;
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
  /** 事件订阅表（按 CDP 方法名分组）。 */
  const listeners = new Map<
    string,
    Set<
      (params: Record<string, unknown>, sessionId?: string | undefined) => void
    >
  >();
  let nextId = 1;
  let closed = false;

  socket.on("message", (raw) => {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      error?: { message?: string };
      result?: unknown;
    };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      // 没有 id = 事件（如 Page.screencastFrame）→ 分发给订阅者
      const subscribers = message.method
        ? listeners.get(message.method)
        : undefined;
      if (!subscribers) return;
      for (const handler of subscribers) {
        try {
          handler(
            (message.params ?? {}) as Record<string, unknown>,
            message.sessionId,
          );
        } catch {
          // 订阅者自己的异常不影响命令通道
        }
      }
      return;
    }
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
    on(method, handler) {
      const set = listeners.get(method) ?? new Set();
      set.add(handler);
      listeners.set(method, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(method);
      };
    },
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

/**
 * 页面里跑的元素描述片段（`readDom` 与 `readPickables` 共用）。
 *
 * 为什么要共用：两处都要「标签 + 可读文字 + 定位提示」，各写一份必然漂移——
 * 实测踩过两次文案/字段不一致。这里是唯一实现，两处都把它注入页面上下文执行。
 */
const PAGE_ELEMENT_HELPERS = `
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const hitHint = (el) => {
    if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute && el.getAttribute("name")) return tag + '[name="' + el.getAttribute("name") + '"]';
    if (el.getAttribute && el.getAttribute("href")) return tag + '[href^="' + String(el.getAttribute("href")).slice(0, 60) + '"]';
    return tag;
  };
  const describeElement = (el) => {
    const tag = el.tagName.toLowerCase();
    let text = clean(el.innerText || el.textContent);
    if (!text && tag === "input") text = el.placeholder || el.name || "(" + (el.type || "text") + ")";
    if (!text && tag === "img") text = el.alt || "(图片)";
    return { tag, text, hint: hitHint(el) };
  };
`;

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
        ${PAGE_ELEMENT_HELPERS}
        const elements = [];
        const push = (el) => {
          if (elements.length >= 60) return;
          const described = describeElement(el);
          if (!described.text) return;
          elements.push(described);
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

/** 拾取候选（带真实几何）：元素盒 + 它在视口里的位置。 */
export interface PickableElement {
  tag: string;
  text: string;
  hint: string;
  /** 边框盒在**视口坐标**里的位置（CSS px，左上角 + 宽高）；拿不到几何时为 null。 */
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface PickablePage {
  url: string;
  title: string;
  /** 视口尺寸（截图与 box 都用这套坐标，客户端据此把 px 换算成百分比）。 */
  viewport: { width: number; height: number };
  elements: PickableElement[];
}

/** 拾取候选的选择器（顺序即优先级，按同页里的出现位置排序后再出）。 */
const PICKABLE_SELECTORS = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "h1",
  "h2",
  "h3",
  "img[alt]",
];

/**
 * 读「可拾取元素」：几何走 **DOM 域**（`DOM.getBoxModel`），不是页面里算出来的矩形。
 *
 * 与 {@link readDom} 的分工：那份给 agent 读内容（`browser_navigate` / `browser_snapshot`），
 * 这份给「选择网页元素加入聊天」的浮层——它要在**页面上叠框点选**，所以需要每个元素的
 * 真实盒模型。用 DOM 域而不是 `getBoundingClientRect`：拿到的是布局后的边框盒
 * （含滚动后的文档坐标），与 DevTools 的「元素盒」同一来源。
 *
 * 坐标对齐：先把页面滚到顶（`window.scrollTo(0, 0)`）再取几何——`getBoxModel` 给的是
 * 文档坐标，滚到顶时与**视口坐标**一致，于是可以和视口截图叠在同一套坐标里。
 *
 * 拿不到盒模型的元素（`display:none`、零尺寸）不丢：`box: null` 保留在列表里，
 * 浮层只给它列表行、不给热点框。
 */
export async function readPickables(
  client: CdpClient,
  sessionId: string,
  options: { limit?: number } = {},
): Promise<PickablePage> {
  const limit = options.limit ?? 40;
  await client.send("DOM.enable", {}, sessionId).catch(() => undefined);
  await client
    .send(
      "Runtime.evaluate",
      { expression: "window.scrollTo(0, 0)", returnByValue: true },
      sessionId,
    )
    .catch(() => undefined);

  const root = (await client.send(
    "DOM.getDocument",
    { depth: 0 },
    sessionId,
  )) as {
    root?: { nodeId?: number };
  };
  const rootId = root.root?.nodeId;
  if (typeof rootId !== "number") {
    throw new CdpError("command_failed", "读取页面 DOM 失败（拿不到根节点）");
  }

  const nodeIds: number[] = [];
  for (const selector of PICKABLE_SELECTORS) {
    if (nodeIds.length >= limit * 2) break;
    const found = (await client
      .send("DOM.querySelectorAll", { nodeId: rootId, selector }, sessionId)
      .catch(() => ({ nodeIds: [] }))) as { nodeIds?: number[] };
    for (const nodeId of found.nodeIds ?? []) {
      if (nodeId) nodeIds.push(nodeId);
    }
  }

  const elements: PickableElement[] = [];
  const seen = new Set<string>();
  for (const nodeId of nodeIds) {
    if (elements.length >= limit) break;
    const described = await describeNode(client, sessionId, nodeId);
    if (!described) continue;
    // 同一元素命中多个选择器（如 `a > img[alt]`）时按「标签+文字+盒」去重
    const box = await boxOf(client, sessionId, nodeId);
    const key = `${described.tag}|${described.text}|${box ? `${box.x},${box.y}` : "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({ ...described, box });
  }

  // 阅读顺序：先上后下、同一行先左后右（拿不到几何的排最后，保持 DOM 顺序）
  elements.sort((a, b) => {
    if (!a.box || !b.box) return a.box ? -1 : b.box ? 1 : 0;
    const rowDelta = a.box.y - b.box.y;
    return Math.abs(rowDelta) > 8 ? rowDelta : a.box.x - b.box.x;
  });

  const meta = (await client.send(
    "Runtime.evaluate",
    {
      expression:
        "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    },
    sessionId,
  )) as { result?: { value?: string } };
  const page = meta.result?.value
    ? (JSON.parse(meta.result.value) as { url: string; title: string })
    : { url: "", title: "" };

  const metrics = (await client
    .send("Page.getLayoutMetrics", {}, sessionId)
    .catch(() => ({}))) as {
    cssVisualViewport?: { clientWidth: number; clientHeight: number };
  };

  return {
    url: page.url,
    title: page.title,
    viewport: {
      width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
      height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
    },
    elements,
  };
}

/** 单个节点的标签/文字/定位提示（走 DOM → 远程对象 → 页面上下文里 describeElement）。 */
async function describeNode(
  client: CdpClient,
  sessionId: string,
  nodeId: number,
): Promise<{ tag: string; text: string; hint: string } | null> {
  const resolved = (await client
    .send("DOM.resolveNode", { nodeId }, sessionId)
    .catch(() => null)) as { object?: { objectId?: string } } | null;
  const objectId = resolved?.object?.objectId;
  if (!objectId) return null;
  try {
    const called = (await client.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function () { ${PAGE_ELEMENT_HELPERS} return describeElement(this); }`,
        returnByValue: true,
      },
      sessionId,
    )) as {
      result?: { value?: { tag?: string; text?: string; hint?: string } };
    };
    const value = called.result?.value;
    if (!value?.tag) return null;
    return {
      tag: value.tag,
      text: value.text ?? "",
      hint: value.hint ?? value.tag,
    };
  } catch {
    return null;
  } finally {
    await client
      .send("Runtime.releaseObject", { objectId }, sessionId)
      .catch(() => undefined);
  }
}

/** 元素的边框盒（`DOM.getBoxModel`）；拿不到几何（无布局盒）时返回 null。 */
async function boxOf(
  client: CdpClient,
  sessionId: string,
  nodeId: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const model = (await client
    .send("DOM.getBoxModel", { nodeId }, sessionId)
    .catch(() => null)) as {
    model?: { border?: number[]; width?: number; height?: number };
  } | null;
  const border = model?.model?.border;
  if (!border || border.length < 2) return null;
  const width = model?.model?.width ?? 0;
  const height = model?.model?.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round((border[0] ?? 0) * 10) / 10,
    y: Math.round((border[1] ?? 0) * 10) / 10,
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
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

/**
 * 命名键表（虚拟键码 / `code` / 要顺带送的文本）。
 *
 * **只有一份**：agent 的 `pressKey`（按键名）与面板内的键盘转发（按 DOM 事件）共用它，
 * 免得两处各写一张表又慢慢漂移。可打印字符不走这里——那条路用 `Input.insertText`
 * （见 dispatchKey），中文输入法合成的结果也走它。
 */
const NAMED_KEYS: Record<string, { vk: number; code: string; text?: string }> =
  {
    Enter: { vk: 13, code: "Enter", text: "\r" },
    NumpadEnter: { vk: 13, code: "NumpadEnter", text: "\r" },
    Tab: { vk: 9, code: "Tab" },
    Escape: { vk: 27, code: "Escape" },
    Backspace: { vk: 8, code: "Backspace" },
    Delete: { vk: 46, code: "Delete" },
    Insert: { vk: 45, code: "Insert" },
    ArrowUp: { vk: 38, code: "ArrowUp" },
    ArrowDown: { vk: 40, code: "ArrowDown" },
    ArrowLeft: { vk: 37, code: "ArrowLeft" },
    ArrowRight: { vk: 39, code: "ArrowRight" },
    Home: { vk: 36, code: "Home" },
    End: { vk: 35, code: "End" },
    PageUp: { vk: 33, code: "PageUp" },
    PageDown: { vk: 34, code: "PageDown" },
    F5: { vk: 116, code: "F5" },
    F12: { vk: 123, code: "F12" },
    " ": { vk: 32, code: "Space", text: " " },
    Space: { vk: 32, code: "Space", text: " " },
  };

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
  return NAMED_KEYS[key]?.vk ?? 0;
}

// ─────────────────────────── 面板内实时视图（画面流 + 交互转发）───────────────────────────
//
// 右栏浏览器面板显示的是**受控浏览器的画面**（而不是 iframe）：iframe 是跨源的，
// 既挂不上调试工具也注不进脚本。画面流走 CDP 的 `Page.startScreencast`，交互回填走
// `Input.dispatch*`——坐标一律是**视口 CSS px**（调用方按面板里的显示尺寸换算）。

/** 开始推画面帧（jpeg）。 */
export async function startScreencast(
  client: CdpClient,
  sessionId: string,
  options: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
    everyNthFrame?: number;
  } = {},
): Promise<void> {
  // 先 enable：不 enable 时部分版本一条帧都不发
  await client.send("Page.enable", {}, sessionId).catch(() => undefined);
  await client.send(
    "Page.startScreencast",
    {
      format: "jpeg",
      quality: options.quality ?? 70,
      maxWidth: options.maxWidth ?? 1600,
      maxHeight: options.maxHeight ?? 1200,
      everyNthFrame: options.everyNthFrame ?? 1,
    },
    sessionId,
  );
}

export async function stopScreencast(
  client: CdpClient,
  sessionId: string,
): Promise<void> {
  await client
    .send("Page.stopScreencast", {}, sessionId)
    .catch(() => undefined);
}

/**
 * 确认收到一帧。
 *
 * **不 ack 就没有下一帧**（Chrome 的背压机制）：所以 ack 必须发生在**这一帧写完/发完之后**，
 * 否则要么丢帧、要么把内存堆爆。参数 `frameSessionId` 是帧事件自带的数字 `sessionId`
 * （与 CDP 会话 id 那个字符串同名不同物，别混）。
 */
export async function ackScreencastFrame(
  client: CdpClient,
  sessionId: string,
  frameSessionId: number,
): Promise<void> {
  await client
    .send("Page.screencastFrameAck", { sessionId: frameSessionId }, sessionId)
    .catch(() => undefined);
}

/** 视口 CSS 尺寸（坐标映射与「自由尺寸」都用它）。 */
export async function readViewport(
  client: CdpClient,
  sessionId: string,
): Promise<{ width: number; height: number; scale: number }> {
  const metrics = (await client.send(
    "Page.getLayoutMetrics",
    {},
    sessionId,
  )) as {
    cssVisualViewport?: {
      clientWidth: number;
      clientHeight: number;
      scale?: number;
    };
    cssLayoutViewport?: { clientWidth: number; clientHeight: number };
  };
  const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  return {
    width: Math.round(viewport?.clientWidth ?? 0),
    height: Math.round(viewport?.clientHeight ?? 0),
    scale: metrics.cssVisualViewport?.scale ?? 1,
  };
}

/**
 * 真实改变页面视口尺寸（「自由尺寸」用它：900px 宽就是真的按 900px 排版，不是把图缩一下）。
 * 传 `null` 还原成窗口尺寸。
 */
export async function setViewportOverride(
  client: CdpClient,
  sessionId: string,
  size: { width: number; height: number } | null,
): Promise<void> {
  if (!size) {
    await client
      .send("Emulation.clearDeviceMetricsOverride", {}, sessionId)
      .catch(() => undefined);
    return;
  }
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: Math.round(size.width),
      height: Math.round(size.height),
      // 0 = 沿用当前缩放因子（不放大像素，画面仍是 1:1 CSS px）
      deviceScaleFactor: 0,
      mobile: false,
      screenWidth: Math.round(size.width),
      screenHeight: Math.round(size.height),
    },
    sessionId,
  );
}

/** 面板内鼠标（坐标是视口 CSS px）。`buttons` 位掩码：拖拽中要带 1，否则页面收不到 drag。 */
export async function dispatchMouse(
  client: CdpClient,
  sessionId: string,
  event: {
    type: "mousePressed" | "mouseReleased" | "mouseMoved";
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | "none";
    buttons?: number;
    clickCount?: number;
    modifiers?: number;
  },
): Promise<void> {
  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: event.type,
      x: Math.round(event.x),
      y: Math.round(event.y),
      button: event.button ?? "left",
      buttons: event.buttons ?? (event.type === "mouseReleased" ? 0 : 1),
      clickCount: event.clickCount ?? 1,
      modifiers: event.modifiers ?? 0,
    },
    sessionId,
  );
}

/** 面板内滚轮（坐标是视口 CSS px；`deltaY > 0` = 向下滚）。 */
export async function dispatchWheel(
  client: CdpClient,
  sessionId: string,
  event: { x: number; y: number; deltaX?: number; deltaY?: number },
): Promise<void> {
  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: Math.round(event.x),
      y: Math.round(event.y),
      deltaX: event.deltaX ?? 0,
      deltaY: event.deltaY ?? 0,
    },
    sessionId,
  );
}

/** 面板内按键：命名键走虚拟键码，可打印字符走 insertText（中文输入法合成的结果也走它）。 */
export async function dispatchKey(
  client: CdpClient,
  sessionId: string,
  event: { key: string; code?: string; modifiers?: number },
): Promise<void> {
  const named = NAMED_KEYS[event.key];
  if (!named) {
    if (event.key.length > 0) {
      await typeText(client, sessionId, event.key);
    }
    return;
  }
  const base: Record<string, unknown> = {
    key: event.key === "Space" ? " " : event.key,
    code: event.code || named.code,
    windowsVirtualKeyCode: named.vk,
    nativeVirtualKeyCode: named.vk,
    modifiers: event.modifiers ?? 0,
  };
  await client.send(
    "Input.dispatchKeyEvent",
    {
      type: "rawKeyDown",
      ...base,
      ...(named.text ? { text: named.text } : {}),
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...base },
    sessionId,
  );
}
