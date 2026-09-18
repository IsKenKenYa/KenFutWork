import { unauthenticatedErrorResponseSchema } from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../auth/types.js";
import { createCdpBrowserSession } from "./cdp-session.js";
import {
  BrowserFetchError,
  type BrowserService,
  createBrowserService,
  fetchPageSnapshot,
} from "./fetch-page.js";
import {
  createViewTicketStore,
  MJPEG_CONTENT_TYPE,
  mjpegPart,
  parseCdpInputEvent,
  samePageUrl,
} from "./view-stream.js";

/**
 * browser 插件（R3-4 / R5-4）：静态快照 + **CDP 浏览器通道**。
 *
 * 三条消费路径：
 * - **人（静态/CDP）**：`POST /api/browser/snapshot` —— 右栏「选择网页元素加入聊天」；
 *   CDP 连着时回来的是**真实渲染页 + 盒模型几何 + 视口截图**（右栏浮层据此叠框点选），
 *   没连时才回落静态抓取的 HTML 元素列表；
 * - **人（CDP）**：`/api/browser/cdp/*` —— 设置页的「连接到 Chrome / 断开 / 状态」；
 * - **agent**：`browser_open`（静态读页，受「允许 AI 控制浏览器」门控）+ 连接后的
 *   `browser_navigate` / `browser_snapshot` / `browser_screenshot` / `browser_act`
 *   （真实渲染后 DOM、截图、点击输入；「自动截图」打开时这些工具会自动附图）。
 */
export function createBrowserPlugin(): PluginDefinition {
  return {
    name: "browser",
    inject: [],
    apply(ctx) {
      const cdp = createCdpBrowserSession({
        get blob() {
          return ctx.tryGet("blob");
        },
      });
      ctx.register("browser", () => createBrowserService(cdp));
      // 权限设置在调用时读（注册期可能还没装配 permissions；且开关是运行期可改的）
      const kernelCtx: PluginContext = ctx;

      const requireBrowserControl = (toolName: string): void => {
        const permissions = kernelCtx.tryGet("permissions");
        if (permissions && !permissions.getSettings().browserControlEnabled) {
          throw new Error(
            `浏览器控制未开启：请到「设置 → 浏览器 → 内置浏览器」里打开「允许 AI 控制浏览器」后重试（${toolName}）。`,
          );
        }
      };
      /**
       * 「允许 AI 读取开发者工具数据」门控（默认开，设置 → 浏览器）。
       * 关掉时工具**如实拒绝**并指路，不静默返回空结果——空结果会被模型当「页面没问题」。
       */
      const requireDevtoolsRead = (toolName: string): void => {
        const settings = kernelCtx.tryGet("permissions")?.getSettings();
        if (settings && !settings.browserDevtoolsReadEnabled) {
          throw new Error(
            `开发者工具数据读取未开启：请到「设置 → 浏览器」里打开「允许 AI 读取开发者工具数据」后重试（${toolName}）。`,
          );
        }
      };
      const autoScreenshot = (): boolean =>
        kernelCtx.tryGet("permissions")?.getSettings().browserAutoScreenshot ??
        false;

      /** 自动截图：开启时给工具结果挂上 screenshotUrl（适配器渲染成图片附件）。 */
      const withShot = async (
        payload: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        if (!autoScreenshot()) return payload;
        try {
          const shot = await cdp.screenshot();
          return { ...payload, ...shot };
        } catch (error) {
          return {
            ...payload,
            screenshotError:
              error instanceof Error ? error.message : "截图失败",
          };
        }
      };

      const tools = ctx.get("tools");

      tools.register({
        name: "browser_open",
        description:
          "打开一个 http/https 网页并读取它的静态内容（标题、正文文本、链接/按钮/输入等元素）。适合读文档、抓页面结构；脚本渲染出来的内容与登录态页面读不到（那两种用 browser_navigate 走 CDP）。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "要打开的页面地址（http/https）",
            },
            mode: {
              type: "string",
              description:
                "text = 只要正文；elements = 只列可交互元素；both = 都要（默认）",
            },
          },
          required: ["url"],
        },
        execute: async (args) => {
          requireBrowserControl("browser_open");
          const url = String(args.url ?? "").trim();
          if (!url) throw new Error("browser_open 需要 url 参数");
          const mode = String(args.mode ?? "both");
          const snapshot = await fetchPageSnapshot(url);
          return {
            url: snapshot.url,
            title: snapshot.title,
            ...(mode === "elements" ? {} : { text: snapshot.text }),
            ...(mode === "text" ? {} : { elements: snapshot.elements }),
          };
        },
      });

      tools.register({
        name: "browser_navigate",
        description:
          "在受控浏览器（CDP，见「设置 → 浏览器 → 外部浏览器」）里打开网址，返回真实渲染后的标题、正文与可交互元素。适合脚本渲染的页面与需要登录态的站点。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的页面地址" },
          },
          required: ["url"],
        },
        execute: async (args) => {
          requireBrowserControl("browser_navigate");
          const url = String(args.url ?? "").trim();
          if (!url) throw new Error("browser_navigate 需要 url 参数");
          return withShot({ ...(await cdp.navigate(url)) });
        },
      });

      tools.register({
        name: "browser_snapshot",
        description:
          "读取受控浏览器当前页面的真实 DOM（标题 / 正文 / 可交互元素）。比 browser_open 更准：拿到的是脚本渲染后的结果。",
        scope: "shared",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          requireBrowserControl("browser_snapshot");
          return withShot({ ...(await cdp.snapshot()) });
        },
      });

      tools.register({
        name: "browser_screenshot",
        description:
          "给受控浏览器的当前页面截一张图，返回可直接查看的图片地址（用于确认页面外观/布局）。",
        scope: "shared",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          requireBrowserControl("browser_screenshot");
          const shot = await cdp.screenshot();
          return { ...shot, title: "浏览器截图" };
        },
      });

      tools.register({
        name: "browser_console",
        description:
          "读取受控浏览器**当前页面**的控制台输出：页面里的 console.log/warn/error、未捕获异常、浏览器错误（网络失败 / CSP 违规）。调试网页时先用它看「这页报了什么错」。传 since 只看新增（上一次结果里的 nextSeq）。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            level: {
              type: "string",
              description: "all（默认）/ error / warn：只看某一档",
            },
            since: {
              type: "number",
              description:
                "只看 seq 大于它的新消息（用上一次返回的 nextSeq；不传给全部）",
            },
            limit: { type: "number", description: "最多返回多少条（默认 50）" },
          },
        },
        execute: async (args) => {
          requireBrowserControl("browser_console");
          requireDevtoolsRead("browser_console");
          const sinceRaw = Number(args.since ?? 0);
          const since =
            Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
          const limitRaw = Number(args.limit ?? 50);
          const limit =
            Number.isFinite(limitRaw) && limitRaw > 0
              ? Math.min(Math.floor(limitRaw), 200)
              : 50;
          const level = String(args.level ?? "all");
          const result = await kernelCtx.get("browser").cdp.messages(since);
          const filtered = result.messages
            .filter((message) =>
              level === "error"
                ? message.level === "error"
                : level === "warn"
                  ? message.level === "warn" || message.level === "error"
                  : true,
            )
            .slice(-limit)
            .map((message) => ({
              level: message.level,
              source: message.source,
              text: message.text,
              at: message.at,
            }));
          return {
            messages: filtered,
            nextSeq: result.nextSeq,
            ...(filtered.length === 0
              ? {
                  note:
                    since > 0
                      ? "自上次以来没有新的控制台输出。"
                      : "这一页还没有控制台输出（页面里的 console.* 与报错都会出现在这里）。",
                }
              : {}),
          };
        },
      });

      tools.register({
        name: "browser_network",
        description:
          "列出受控浏览器**当前页面**发出的网络请求（方法、URL、状态码、失败原因）。用来确认「点了按钮有没有真的发请求 / 哪个请求失败了」。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "all（默认）/ failed：只看失败或 4xx/5xx",
            },
            since: {
              type: "number",
              description: "只看 seq 大于它的新请求（用上一次返回的 nextSeq）",
            },
            limit: { type: "number", description: "最多返回多少条（默认 50）" },
          },
        },
        execute: async (args) => {
          requireBrowserControl("browser_network");
          requireDevtoolsRead("browser_network");
          const sinceRaw = Number(args.since ?? 0);
          const since =
            Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
          const limitRaw = Number(args.limit ?? 50);
          const limit =
            Number.isFinite(limitRaw) && limitRaw > 0
              ? Math.min(Math.floor(limitRaw), 200)
              : 50;
          const onlyFailed = String(args.filter ?? "all") === "failed";
          const result = await kernelCtx.get("browser").cdp.requests(since);
          const requests = result.requests
            .filter((request) =>
              onlyFailed
                ? Boolean(request.failed) ||
                  (request.status !== undefined && request.status >= 400)
                : true,
            )
            .slice(-limit)
            .map((request) => ({
              method: request.method,
              url: request.url,
              ...(request.status === undefined
                ? {}
                : { status: request.status }),
              ...(request.failed ? { failed: request.failed } : {}),
              ...(request.type ? { type: request.type } : {}),
            }));
          return {
            requests,
            nextSeq: result.nextSeq,
            ...(requests.length === 0
              ? {
                  note: onlyFailed
                    ? "没有失败或 4xx/5xx 的请求。"
                    : "还没有捕获到请求（先 browser_navigate 打开页面，再操作）。",
                }
              : {}),
          };
        },
      });

      tools.register({
        name: "browser_act",
        description:
          "在受控浏览器里操作页面：click（点元素，给 selector 或坐标）/ type（向焦点输入文本）/ key（按键，如 Enter）。用完后建议 browser_snapshot 看结果。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "click / type / key" },
            selector: { type: "string", description: "click 用：CSS 选择器" },
            x: {
              type: "number",
              description: "click 用：坐标（与 selector 二选一）",
            },
            y: { type: "number", description: "click 用：坐标" },
            text: { type: "string", description: "type 用：要输入的文本" },
            key: {
              type: "string",
              description: "key 用：如 Enter / Tab / Escape",
            },
          },
          required: ["action"],
        },
        execute: async (args) => {
          requireBrowserControl("browser_act");
          const action = String(args.action ?? "");
          if (action === "click") {
            await cdp.click({
              ...(typeof args.selector === "string" && args.selector
                ? { selector: args.selector }
                : {}),
              ...(typeof args.x === "number" ? { x: args.x } : {}),
              ...(typeof args.y === "number" ? { y: args.y } : {}),
            });
          } else if (action === "type") {
            await cdp.type(String(args.text ?? ""));
          } else if (action === "key") {
            await cdp.key(String(args.key ?? "Enter"));
          } else {
            throw new Error("browser_act 的 action 只支持 click / type / key");
          }
          return withShot({ ok: true, action });
        },
      });
    },
    mounted(ctx) {
      registerBrowserRoutes(ctx.app, {
        auth: ctx.get("auth"),
        browser: ctx.get("browser"),
        settingsForHeadless: () =>
          ctx.tryGet("permissions")?.getSettings().browserHeadless ?? false,
      });
    },
  };
}

/** 右栏面板与设置页用的浏览器端点（都需登录）。 */
export function registerBrowserRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    browser: BrowserService;
    /** CDP 连接时是否无头（读实例设置；缺省有窗口）。 */
    settingsForHeadless?: () => boolean;
  },
): void {
  const sendUnauthorized = (reply: FastifyReply) => {
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      }),
    );
    return null;
  };
  /**
   * 画面流票据（面板的 `<img>` 发不了登录头，只能用 URL 凭证；短时 + 一次性，见 view-stream）。
   * 每个装配一份（`registerBrowserRoutes` 每进程只调一次）。
   */
  const tickets = createViewTicketStore();
  const authenticate = async (
    request: Parameters<RequestAuthenticator["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | null> =>
    (await options.auth.authenticate(request)) ?? sendUnauthorized(reply);

  app.post("/api/browser/snapshot", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const url = (request.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !url.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "缺少 url。" },
      });
    }
    // CDP 已连接时优先用它（真实渲染后 DOM + **真实盒模型**，跨源/登录态都能拿到，
    // 浮层因此能在截图上叠框点选）；否则回落静态快照
    if (options.browser.cdp.isConnected()) {
      try {
        /**
         * 受控浏览器**已经在这一页**就只读、不导航：面板里显示的就是这一页，
         * 重来一次 `Page.navigate` 会整页重载（滚动位置与面板里的调试控制台一起没了）。
         */
        const status = options.browser.cdp.status();
        const current = status.status === "connected" ? status.currentUrl : "";
        const dom = samePageUrl(current, url)
          ? await options.browser.cdp.snapshot()
          : await options.browser.cdp.navigate(url);
        const picked = await options.browser.cdp.pickables();
        return reply.code(200).send({
          snapshot: {
            url: dom.url,
            title: dom.title,
            text: dom.text,
            viewport: picked.viewport,
            // 元素取带几何的那一份（含 box）；静态那路的元素没有 box
            elements: picked.elements,
          },
          ...(picked.screenshotUrl
            ? { screenshotUrl: picked.screenshotUrl }
            : {}),
          source: "cdp",
        });
      } catch (error) {
        // 回落静态抓取：CDP 偶发失败（页面忙/权限）时，静态快照仍能给点东西。
        // 但原因必须留痕——否则界面只显示「静态」而无从判断 CDP 为什么没接上。
        console.warn(
          "[browser] CDP 拾取失败，回落静态抓取：",
          error instanceof Error ? error.message : error,
        );
      }
    }
    try {
      const snapshot = await options.browser.snapshot(url);
      return reply.code(200).send({ snapshot, source: "static" });
    } catch (error) {
      if (error instanceof BrowserFetchError) {
        return reply
          .code(
            error.code === "invalid_url" || error.code === "blocked_host"
              ? 400
              : 502,
          )
          .send({ error: { code: error.code, message: error.message } });
      }
      return reply.code(502).send({
        error: {
          code: "fetch_failed",
          message: error instanceof Error ? error.message : "抓取失败。",
        },
      });
    }
  });

  // ── CDP 通道（R5-4「连接到 Chrome」/「自动截图」）──

  app.get("/api/browser/cdp/status", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    return reply.code(200).send({ cdp: options.browser.cdp.status() });
  });

  app.post("/api/browser/cdp/connect", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    /**
     * 无头与否：默认读设置（「设置 → 浏览器 → 通用」）。右栏面板会显式传 `true`——
     * 面板里看的就是这个浏览器的画面，再弹一个窗口出来纯属多余（用户口径：「不要跳转外部」）。
     */
    const body = (request.body ?? {}) as { headless?: unknown };
    const headless =
      typeof body.headless === "boolean"
        ? body.headless
        : (options.settingsForHeadless?.() ?? false);
    const status = await options.browser.cdp.connect({ headless });
    return reply
      .code(status.status === "connected" ? 200 : 502)
      .send({ cdp: status });
  });

  /**
   * 面板画面流的**开流手续**：确认受控浏览器在、把页面导航到目标地址、换一张票据。
   *
   * 分开两步（POST 换票 + GET 开流）是因为 `<img>` 发不了 `Authorization` 头，
   * 而真正开流的请求是浏览器替我们发的。
   */
  app.post("/api/browser/cdp/view", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = (request.body ?? {}) as {
      url?: unknown;
      width?: unknown;
      height?: unknown;
      quality?: unknown;
      /** 「刷新」：同一页也要重新导航一次（否则面板上的刷新按钮在实时画面下是死的）。 */
      reload?: unknown;
    };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const width = typeof body.width === "number" ? Math.round(body.width) : 0;
    const height =
      typeof body.height === "number" ? Math.round(body.height) : 0;
    const quality =
      typeof body.quality === "number" && body.quality > 0
        ? Math.round(body.quality)
        : 70;
    const cdp = options.browser.cdp;
    if (!cdp.isConnected()) {
      return reply.code(409).send({
        error: {
          code: "cdp_not_connected",
          message:
            "受控浏览器还没连上：先在「设置 → 浏览器 → 外部浏览器」连接，或点这个面板的刷新重试。",
        },
      });
    }
    try {
      if (url) {
        /**
         * 已经在这一页就别再导航一次（重复导航会整页重载：滚动、表单、调试控制台全丢）。
         * 例外是**用户明确点了刷新**（`reload`）——那时候要的就是整页重载。
         */
        const status = cdp.status();
        const current = status.status === "connected" ? status.currentUrl : "";
        if (body.reload === true || !samePageUrl(current, url)) {
          await cdp.navigate(url);
        }
      }
      // 「自由尺寸」= 真视口尺寸（面板画面按它排版，不是把图缩放一下）
      await cdp.resize(width > 0 && height > 0 ? { width, height } : null);
      const viewport = await cdp.viewport();
      return reply.code(200).send({
        ticket: tickets.mint({ width, height, quality }),
        viewport,
      });
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_view_failed",
          message:
            error instanceof Error ? error.message : "打开面板画面失败。",
        },
      });
    }
  });

  /** 面板画面流本体（MJPEG：浏览器拿 `<img>` 直接渲染，客户端零解码代码）。 */
  app.get("/api/browser/cdp/stream", async (request, reply) => {
    const ticket = (request.query as { ticket?: string } | undefined)?.ticket;
    const meta = tickets.take(ticket);
    if (!meta) {
      return reply.code(401).send({
        error: {
          code: "invalid_ticket",
          message: "画面流的票据无效或已过期。",
        },
      });
    }
    /**
     * 开流**之前**先探一次会话：这时还能用正常的 JSON 错误回话。
     * `reply.hijack()` 之后响应就归我们手写了，只能靠断流表达失败。
     */
    try {
      await options.browser.cdp.viewport();
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_not_connected",
          message:
            error instanceof Error ? error.message : "受控浏览器未连接。",
        },
      });
    }
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": MJPEG_CONTENT_TYPE,
      "Cache-Control": "no-store, no-transform",
      Connection: "close",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let stop: (() => Promise<void>) | null = null;
    const finish = () => {
      if (closed) return;
      closed = true;
      void stop?.();
      response.end();
    };
    try {
      stop = await options.browser.cdp.watch(meta, async (jpeg) => {
        if (closed) return;
        const flushed = response.write(mjpegPart(jpeg));
        // 写不动就等 drain：上游（Chrome）以 ack 做背压，这里再堆帧只会把内存堆爆
        if (!flushed) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      });
    } catch (error) {
      // 已经 hijack 了：回不了 JSON，只能断流。但原因要留痕，否则面板里只显示「流断了」
      console.warn(
        "[browser] 画面流没能开始推送：",
        error instanceof Error ? error.message : error,
      );
      finish();
      return reply;
    }
    request.raw.on("close", finish);
    request.raw.on("error", finish);
    return reply;
  });

  /** 面板内的交互回填（鼠标 / 滚轮 / 键盘 / 文本；坐标是视口 CSS px）。 */
  app.post("/api/browser/cdp/input", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const event = parseCdpInputEvent(request.body);
    if (!event) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "输入事件形状不对。" },
      });
    }
    try {
      await options.browser.cdp.input(event);
      return reply.code(200).send({ ok: true });
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_input_failed",
          message: error instanceof Error ? error.message : "转发输入失败。",
        },
      });
    }
  });

  /**
   * 悬浮控制台的**消息拉取**（面板里的悬浮窗轮询它；`since` = 已拿到的最大 seq）。
   *
   * 为什么是轮询而不是长连接：本地回环上一次几十字节的请求成本可忽略，而长连接要往
   * WS 协议里加一套浏览器消息——为这点流量不划算。
   */
  app.get("/api/browser/cdp/messages", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const sinceRaw = (request.query as { since?: string } | undefined)?.since;
    const since = Number(sinceRaw);
    try {
      const result = await options.browser.cdp.messages(
        Number.isFinite(since) && since > 0 ? Math.floor(since) : 0,
      );
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_messages_failed",
          message:
            error instanceof Error ? error.message : "读取控制台消息失败。",
        },
      });
    }
  });

  /** 悬浮控制台里敲的表达式：在页面里执行并回一行结果。 */
  app.post("/api/browser/cdp/eval", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const expression = (request.body as { expression?: unknown } | undefined)
      ?.expression;
    if (typeof expression !== "string" || !expression.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "缺少表达式。" },
      });
    }
    try {
      const message = await options.browser.cdp.evaluate(expression);
      return reply.code(200).send({ message });
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_eval_failed",
          message: error instanceof Error ? error.message : "执行表达式失败。",
        },
      });
    }
  });

  /** 清空控制台缓存（界面上的「清空」按钮）。 */
  app.post("/api/browser/cdp/messages/clear", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    await options.browser.cdp.clearMessages();
    return reply.code(200).send({ ok: true });
  });

  /** 「完整面板」：注入 Eruda 到受控页面（Elements / Network / Storage 那些页内面板）。 */
  app.post("/api/browser/cdp/console", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const url = (request.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !url.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "缺少 url。" },
      });
    }
    try {
      const result = await options.browser.cdp.injectDebugConsole(url);
      return reply.code(200).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "注入调试控制台失败。";
      return reply.code(502).send({
        error: { code: "cdp_console_failed", message },
      });
    }
  });

  /**
   * 调试控制台脚本源码：桌面形态取它去 `eval` 进面板里的子 WebView2。
   *
   * 与 Web 形态（CDP 注入）**同一份**源码——两边各存一份迟早漂移。
   */
  app.get("/api/browser/debug-console.js", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    try {
      const script = await options.browser.cdp.debugConsoleScript();
      return reply
        .code(200)
        .type("application/javascript; charset=utf-8")
        .header("cache-control", "no-store")
        .send(script);
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "debug_console_unavailable",
          message:
            error instanceof Error ? error.message : "拿不到调试控制台脚本。",
        },
      });
    }
  });

  app.post("/api/browser/cdp/disconnect", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    return reply
      .code(200)
      .send({ cdp: await options.browser.cdp.disconnect() });
  });
}
