import type { FastifyInstance } from "fastify";
import { unauthenticatedErrorResponseSchema } from "@kenfutwork/shared";

import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import type { RequestAuthenticator } from "../auth/types.js";
import {
  BrowserFetchError,
  createBrowserService,
  type BrowserService,
} from "./fetch-page.js";

/**
 * browser 插件（R3-4 / R5-4）：右栏浏览器的「元素拾取」与服务端的受控抓取。
 *
 * 两条消费路径：
 * - **人**：`POST /api/browser/snapshot` —— 右栏面板的「选择网页元素加入聊天」用它拿元素列表；
 * - **agent**：`browser_open` 工具 —— 让 agent 能读一个页面（受设置 → 浏览器里的
 *   「允许 AI 控制浏览器」门控；关着的时候**如实拒绝并说明去哪打开**，而不是把工具摘掉——
 *   摘掉会让模型以为这个能力不存在）。
 */
export function createBrowserPlugin(): PluginDefinition {
  return {
    name: "browser",
    inject: [],
    apply(ctx) {
      ctx.register("browser", () => createBrowserService());
      // 权限设置在调用时读（注册期可能还没装配 permissions；且开关是运行期可改的）
      const kernelCtx: PluginContext = ctx;
      ctx.get("tools").register({
        name: "browser_open",
        description:
          "打开一个 http/https 网页并读取它的静态内容（标题、正文文本、链接/按钮/输入等元素）。适合读文档、抓页面结构；脚本渲染出来的内容与登录态页面读不到。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的页面地址（http/https）" },
            mode: {
              type: "string",
              description: "text = 只要正文；elements = 只列可交互元素；both = 都要（默认）",
            },
          },
          required: ["url"],
        },
        execute: async (args) => {
          const permissions = kernelCtx.tryGet("permissions");
          if (permissions && !permissions.getSettings().browserControlEnabled) {
            throw new Error(
              "浏览器控制未开启：请到「设置 → 浏览器 → 内置浏览器」里打开「允许 AI 控制浏览器」，再重试。",
            );
          }
          const url = String(args.url ?? "").trim();
          if (!url) throw new Error("browser_open 需要 url 参数");
          const mode = String(args.mode ?? "both");
          const snapshot = await kernelCtx.get("browser").snapshot(url);
          return {
            url: snapshot.url,
            title: snapshot.title,
            ...(mode === "elements" ? {} : { text: snapshot.text }),
            ...(mode === "text" ? {} : { elements: snapshot.elements }),
          };
        },
      });
    },
    mounted(ctx) {
      registerBrowserRoutes(ctx.app, {
        auth: ctx.get("auth"),
        browser: ctx.get("browser"),
      });
    },
  };
}

/** 右栏面板用的快照端点（需登录；抓取口径见 fetch-page.ts 顶注）。 */
export function registerBrowserRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; browser: BrowserService },
): void {
  app.post("/api/browser/snapshot", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: { code: "unauthorized", message: "Missing or invalid bearer token." },
        }),
      );
    }
    const url = (request.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !url.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "缺少 url。" },
      });
    }
    try {
      const snapshot = await options.browser.snapshot(url);
      return reply.code(200).send({ snapshot });
    } catch (error) {
      if (error instanceof BrowserFetchError) {
        return reply
          .code(error.code === "invalid_url" || error.code === "blocked_host" ? 400 : 502)
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
}
