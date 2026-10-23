import { join } from "node:path";
import { unauthenticatedErrorResponseSchema } from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveDesktopDataDir } from "../../desktop/paths.js";

import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import type { LocalAccessVerifier } from "../local-access/types.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCdpBrowserSession } from "./cdp-session.js";
import {
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
 * browser 插件（R3-4 / R5-4）：**CDP 浏览器通道**。
 *
 * 两条消费路径：
 * - **人（面板）**：`/api/browser/cdp/*` —— 右栏浏览器面板的画面流 / 输入 / 调试控制台 /
 *   截图到对话 / 页面内元素选择器（picker）；
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
        dataDir: join(
          resolveDesktopDataDir({
            env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
          }),
          "browser",
        ),
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
      /**
       * 「允许 AI 在页面执行任意 JS」门控（`browser_eval`；默认关）。
       * eval 把能力从「看和点」扩到「任意脚本」——独立于 devtools_read 的一道权限，
       * 关掉时如实拒绝并指路，不静默降级成空结果。
       */
      const requireBrowserEval = (toolName: string): void => {
        const settings = kernelCtx.tryGet("permissions")?.getSettings();
        if (settings && !settings.browserEvalEnabled) {
          throw new Error(
            `页面内执行脚本未开启：请到「设置 → 浏览器」里打开「允许 AI 在页面执行脚本」后重试（${toolName}）。`,
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
          "打开一个 http/https 网页并读取它的静态内容（标题、正文文本、链接/按钮/输入等元素）。适合读文档、抓页面结构；**没有配 web_search 时，用它打开搜索引擎结果页（如 https://www.bing.com/search?q=关键词）就是「搜索+抓取」那条路**。脚本渲染出来的内容与登录态页面读不到（那两种用 browser_navigate 走 CDP）。",
        scope: "shared",
        exposure: "deferred",
        access: "read",
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
        exposure: "deferred",
        access: "execute",
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
        exposure: "deferred",
        access: "read",
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
        exposure: "deferred",
        access: "read",
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
        exposure: "deferred",
        access: "read",
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
          "列出受控浏览器**当前页面**发出的网络请求（方法、URL、状态码、失败原因、耗时、响应 MIME）。用来确认「点了按钮有没有真的发请求 / 哪个请求失败了 / 慢在哪」。需要看请求体或响应内容时把 bodies 打开（默认不带，内容可能较大）。",
        scope: "shared",
        exposure: "deferred",
        access: "read",
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
            bodies: {
              type: "boolean",
              description:
                "带上请求体 / 响应体（文本类且体积在上限内才采到；默认 false）",
            },
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
          const withBodies = args.bodies === true;
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
              ...(request.mimeType ? { mimeType: request.mimeType } : {}),
              ...(request.durationMs === undefined
                ? {}
                : { durationMs: request.durationMs }),
              ...(withBodies && request.requestBody !== undefined
                ? { requestBody: request.requestBody }
                : {}),
              ...(withBodies && request.responseBody !== undefined
                ? { responseBody: request.responseBody }
                : {}),
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
        exposure: "deferred",
        access: "execute",
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

      tools.register({
        name: "browser_eval",
        description:
          "在受控浏览器的当前页面里执行一段 JavaScript 并返回结果（值 / 类型；抛错则回错误文本）。用于读取页面状态、调用页面自己的 API、驱动前端逻辑做验证。需要「允许 AI 在页面执行脚本」权限（设置 → 浏览器，默认关）。结果尽量小：返回可序列化的值。",
        scope: "shared",
        exposure: "deferred",
        access: "execute",
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description:
                "要执行的 JS 表达式（返回一个值；可用 await，支持 Promise）",
            },
          },
          required: ["expression"],
        },
        execute: async (args) => {
          requireBrowserControl("browser_eval");
          requireBrowserEval("browser_eval");
          const expression = String(args.expression ?? "").trim();
          if (!expression) throw new Error("browser_eval 需要 expression 参数");
          // 与 browser_console / browser_network 同一条通路：经 `ctx.get("browser")` 解析，
          // 而不是闭包里的会话——「overrides 优先」的口径要一致，测试与替换才都能生效。
          const result = await kernelCtx
            .get("browser")
            .cdp.evaluateValue(expression);
          if (!result.ok) {
            return { ok: false, error: result.error ?? "执行出错" };
          }
          return withShot({ ok: true, type: result.type, value: result.value });
        },
      });
    },
    mounted(ctx) {
      registerBrowserRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
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
    localAccess: LocalAccessVerifier;
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
  /** 当前那一路画面流的收尾函数（同一时刻只留一路，新流开起来时把上一路收掉）。 */
  let activeStreamFinish: (() => Promise<void>) | null = null;
  const streamFinishes = new Set<() => Promise<void>>();
  let closingStreams = false;
  app.addHook("preClose", async () => {
    closingStreams = true;
    const results = await Promise.allSettled(
      [...streamFinishes].map((finish) => finish()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "浏览器画面流尚未确认关闭。");
  });
  const authenticate = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<LocalActor | null> =>
    (await options.localAccess.authenticate(request)) ??
    sendUnauthorized(reply);

  // ── CDP 通道（R5-4「连接到 Chrome」/「自动截图」）──

  app.get("/api/browser/cdp/status", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const cdp = options.browser.cdp;
    const status = cdp.status();
    // 页面主线程探针：注入脚本/网页自身卡死时面板据此提示「画面已卡住」，
    // 不让整块面板看起来像死了（探针本身 1.5s 超时，失败只影响这个字段）。
    const responsive = status.status === "connected" ? await cdp.ping() : false;
    return reply.code(200).send({ cdp: { ...status, responsive } });
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
    if (closingStreams)
      return reply.code(503).send({
        error: {
          code: "browser_shutting_down",
          message: "浏览器画面服务正在关闭。",
        },
      });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": MJPEG_CONTENT_TYPE,
      "Cache-Control": "no-store, no-transform",
      Connection: "close",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let resolveWatcher!: (stop: (() => Promise<void>) | null) => void;
    const watcherReady = new Promise<(() => Promise<void>) | null>(
      (resolve) => {
        resolveWatcher = resolve;
      },
    );
    let finished: Promise<void> | undefined;
    const finish = (): Promise<void> => {
      if (finished) return finished;
      closed = true;
      finished = (async () => {
        const stop = await watcherReady;
        await stop?.();
      })().finally(() => {
        if (activeStreamFinish === finish) activeStreamFinish = null;
        streamFinishes.delete(finish);
        response.off("close", responseClosed);
        response.off("error", responseClosed);
      });
      // HTTP先结束，CDP准备/停止仍由同一个Promise归还，迟到句柄不能遗失。
      response.end();
      return finished;
    };
    const responseClosed = () => {
      void finish().catch((error: unknown) => {
        request.log.warn({ err: error }, "浏览器画面流资源释放失败。");
      });
    };
    streamFinishes.add(finish);
    response.once("close", responseClosed);
    response.once("error", responseClosed);
    /**
     * 同一时刻只留**一路**画面流：上一路（面板换页/换视口时留下的那条）在这里收掉。
     *
     * 为什么必须收：每个流都占一条 `Connection: close` 的独立连接（不会进 keep-alive 池），
     * 不收就是越开越多；浏览器的每主机连接上限（6）被占满之后，面板自己的
     * `status` / `view` 请求会排在队列里发不出去——真机实测：多次换地址后面板卡在
     * 「正在打开内嵌浏览器…」再也不回来（pane 侧日志停在 `open() 开始`，服务端看不到那次
     * `status`）。上一路流下游已没人看（img 被换掉/卸载），收掉它不损失任何画面。
     */
    const previous = activeStreamFinish;
    activeStreamFinish = finish;
    try {
      // 旧stop尚在恢复视口时不能启动新watch，避免旧操作迟到关闭新画面。
      await previous?.();
      if (closed) {
        resolveWatcher(null);
        await finish();
        return reply;
      }
      const stop = await options.browser.cdp.watch(meta, async (jpeg) => {
        if (closed) return;
        const flushed = response.write(mjpegPart(jpeg));
        // 写不动就等 drain：上游（Chrome）以 ack 做背压，这里再堆帧只会把内存堆爆
        if (!flushed) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      });
      resolveWatcher(stop);
    } catch (error) {
      resolveWatcher(null);
      // 已经 hijack 了：回不了 JSON，只能断流。但原因要留痕，否则面板里只显示「流断了」
      console.warn(
        "[browser] 画面流没能开始推送：",
        error instanceof Error ? error.message : error,
      );
      await finish();
      return reply;
    }
    if (closed) await finish();
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
   * 「打开调试工具」：把**页面内调试控制台**（Eruda，现成第三方）注入到面板显示的这一页，
   * 并摆成悬浮窗（可拖动 / 可关闭）。用户口径：「之前用的不是参考别人的控制台吗」。
   */
  app.post("/api/browser/cdp/console", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = request.body as
      | { url?: unknown; action?: unknown }
      | undefined;
    const url = body?.url;
    // 收起悬浮控制台（拾取等面板交互前清场）：只 hide 不销毁，可再唤出。
    if (body?.action === "close") {
      try {
        await options.browser.cdp.hideDebugConsole();
        return reply
          .code(200)
          .send({ url: typeof url === "string" ? url : "" });
      } catch (error) {
        return reply.code(502).send({
          error: {
            code: "cdp_console_failed",
            message:
              error instanceof Error ? error.message : "收起调试控制台失败。",
          },
        });
      }
    }
    if (typeof url !== "string" || !url.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "缺少 url。" },
      });
    }
    try {
      const result = await options.browser.cdp.injectDebugConsole(url);
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_console_failed",
          message:
            error instanceof Error ? error.message : "注入调试控制台失败。",
        },
      });
    }
  });

  /** 截当前视口（base64 直出）——面板「截图到对话」组 File 用，不落 blob。 */
  app.post("/api/browser/cdp/screenshot", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    try {
      const shot = await options.browser.cdp.screenshotData();
      return reply.code(200).send(shot);
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_screenshot_failed",
          message: error instanceof Error ? error.message : "截图失败。",
        },
      });
    }
  });

  /**
   * 页面内元素选择器（DevTools 拾取器同款）：start 注入跟随鼠标的高亮脚本，
   * read 取走点选结果（读后即清），stop 退出。高亮在页面里画——坐标永远精确、
   * 所有元素可选（旧快照叠框方案错位 + 元素不全，已废弃）。
   */
  app.post("/api/browser/cdp/picker", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const action = (request.body as { action?: unknown } | undefined)?.action;
    try {
      if (action === "start") {
        await options.browser.cdp.startElementPicker();
        return reply.code(200).send({ ok: true });
      }
      if (action === "read") {
        return reply
          .code(200)
          .send(await options.browser.cdp.readPickedElement());
      }
      if (action === "stop") {
        await options.browser.cdp.stopElementPicker();
        return reply.code(200).send({ ok: true });
      }
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "action 只能是 start/read/stop。",
        },
      });
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_picker_failed",
          message:
            error instanceof Error ? error.message : "元素选择器操作失败。",
        },
      });
    }
  });

  /** 调试控制台脚本源码：桌面形态取它去 `eval` 进面板里的子 WebView2（同一份）。 */
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

  /**
   * 「完整开发者工具」：在受控浏览器里开真 DevTools 并取消停靠成独立窗口，并取消停靠成独立窗口。
   *
   * 为什么是「激活窗口 + F12」这条路（见 devtools-keys 的头注）：CDP 开出来的 devtools://
   * 窗口没有前端桥，连不上页面；只有浏览器自己开的 DevTools 才是真的。
   */
  app.post("/api/browser/cdp/devtools", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const body = (request.body ?? {}) as {
      left?: unknown;
      top?: unknown;
      width?: unknown;
      height?: unknown;
    };
    const size = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : undefined;
    try {
      const left = size(body.left);
      const top = size(body.top);
      const width = size(body.width);
      const height = size(body.height);
      const opened = await options.browser.cdp.openDevToolsWindow({
        ...(left === undefined ? {} : { left }),
        ...(top === undefined ? {} : { top }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      });
      return reply.code(200).send(opened);
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: "cdp_devtools_failed",
          message:
            error instanceof Error ? error.message : "打开开发者工具失败。",
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
