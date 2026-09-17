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
        const dom = await options.browser.cdp.navigate(url);
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
    const headless = options.settingsForHeadless?.() ?? false;
    const status = await options.browser.cdp.connect({ headless });
    return reply
      .code(status.status === "connected" ? 200 : 502)
      .send({ cdp: status });
  });

  app.post("/api/browser/cdp/disconnect", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    return reply
      .code(200)
      .send({ cdp: await options.browser.cdp.disconnect() });
  });
}
