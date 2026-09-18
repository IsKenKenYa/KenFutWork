import {
  applicationErrorResponseSchema,
  pluginExportRequestSchema,
  pluginInspectRequestSchema,
  pluginInspectResponseSchema,
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
  sandboxPluginBundleListResponseSchema,
  sandboxPluginInstallRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminService } from "../features/admin/admin-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import type { PluginRegistryService } from "../features/plugins/plugin-registry-service.js";
import { PluginRegistryError } from "../features/plugins/plugin-registry-service.js";
import { listSandboxPluginBundles } from "../features/plugins/sandbox-plugin-bundles.js";
import { resolveInsideRoot } from "../utils/inside-root.js";
import { resolveSandboxForCanvas } from "./sandbox-scope.js";

/**
 * 插件市场与安装路由。
 *
 * 权限模型：**读取**（列表/校验/导出）只需登录；**变更**（安装/卸载/启停）额外要求
 * 管理员——安装会拉取并在本机执行第三方代码，是实例级危险操作，不能给普通用户。
 * 安装前一律先过兼容性门禁，未通过即 422 并回传完整报告（不落盘、不装载）。
 */

export interface PluginRoutesDeps {
  auth: RequestAuthenticator;
  admin: AdminService;
  registry: PluginRegistryService;
  /** 「从工作目录安装」需要：画布归属校验 + 沙箱目录解析（与技能/agent 同一处）。 */
  canvasRepository: CanvasRepository;
  viewerService: ViewerService;
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
  /** 项目绑定的本机工作目录（`projects.work_dir`）；界面绑定优先于环境变量映射。 */
  projectWorkDirLoader?:
    | ((canvasId: string) => Promise<string | null>)
    | undefined;
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "请先登录。" },
    }),
  );
}

/**
 * 插件路由的工作区上下文：与其它聚合同一口径（viewer 解析当前用户的工作区）。
 *
 * 解析失败（例如身份已建但个人工作区缺失）**不在这里 500**：公共面板路由本就没有身份，
 * 而插件真的读写存储时，存储层会因缺工作区 fail loud——报错点离出错点更近，更好排查。
 */
async function resolveWorkspaceId(
  viewerService: ViewerService,
  user: AuthenticatedUser,
): Promise<string | undefined> {
  try {
    const workspace = await viewerService.resolveWorkspace(user);
    return workspace.id;
  } catch {
    return undefined;
  }
}

function sendError(
  reply: FastifyReply,
  code: string,
  message: string,
  status: number,
) {
  return reply.code(status).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
}

export async function registerPluginRoutes(
  app: FastifyInstance,
  options: PluginRoutesDeps,
) {
  /** 登录 + 管理员双重门（变更类端点用）。 */
  const requireAdmin = async (
    request: Parameters<RequestAuthenticator["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<boolean> => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      void sendUnauthenticated(reply);
      return false;
    }
    try {
      await options.admin.requireAdmin(user);
    } catch {
      void sendError(reply, "forbidden", "需要管理员权限。", 403);
      return false;
    }
    return true;
  };

  app.get("/api/plugins", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    return reply.code(200).send({ plugins: await options.registry.list() });
  });

  // 只校验不安装：让 UI 在用户点「安装」前就能看到门禁结论
  app.post("/api/plugins/inspect", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const parsed = pluginInspectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "请求参数不合法。", 400);
    }
    try {
      const result = await options.registry.inspect(parsed.data);
      return reply.code(200).send(pluginInspectResponseSchema.parse(result));
    } catch (error) {
      request.log.warn({ err: error }, "plugin inspect failed");
      return sendError(
        reply,
        "plugin_source_failed",
        error instanceof Error ? error.message : "无法获取插件来源。",
        502,
      );
    }
  });

  app.post("/api/plugins/install", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;

    const parsed = pluginInstallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "请求参数不合法。", 400);
    }
    try {
      const result = await options.registry.install(parsed.data);
      return reply.code(201).send(pluginInstallResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof PluginRegistryError) {
        if (error.report) {
          return reply.code(422).send({
            error: { code: "plugin_incompatible", message: error.message },
            report: error.report,
          });
        }
        const status = error.code === "system_plugin" ? 403 : 400;
        return sendError(reply, error.code, error.message, status);
      }
      request.log.error({ err: error }, "plugin install failed");
      return sendError(reply, "install_failed", "安装失败。", 500);
    }
  });

  // GET /api/plugins/sandbox-bundles?canvasId=… — 列出工作目录里的插件 bundle 候选
  // （「从工作目录安装」用：agent/创造模式在工作目录里写出来的 bundle 在这里被发现）
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/plugins/sandbox-bundles",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return sendError(reply, "invalid_request", "缺少 canvasId。", 400);
      }
      const sandboxDir = await resolveSandboxForCanvas(
        {
          viewerService: options.viewerService,
          canvasRepository: options.canvasRepository,
          sandboxRoot: options.sandboxRoot,
          canvasWorkDirs: options.canvasWorkDirs,
          projectWorkDirLoader: options.projectWorkDirLoader,
        },
        user,
        canvasId,
      );
      if (!sandboxDir) {
        return sendError(
          reply,
          "not_found",
          "画布不存在或不属于当前工作区。",
          404,
        );
      }
      return reply.code(200).send(
        sandboxPluginBundleListResponseSchema.parse({
          bundles: listSandboxPluginBundles(sandboxDir),
        }),
      );
    },
  );

  // POST /api/plugins/sandbox-install — 把工作目录里的 bundle 目录安装到本实例
  // 与 /api/plugins/install 同一道 admin 门：插件会加载执行第三方代码（本机目录也不例外）
  app.post("/api/plugins/sandbox-install", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;

    const parsed = sandboxPluginInstallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "请求参数不合法。", 400);
    }
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const sandboxDir = await resolveSandboxForCanvas(
      {
        viewerService: options.viewerService,
        canvasRepository: options.canvasRepository,
        sandboxRoot: options.sandboxRoot,
        canvasWorkDirs: options.canvasWorkDirs,
      },
      user as AuthenticatedUser,
      parsed.data.canvasId,
    );
    if (!sandboxDir) {
      return sendError(
        reply,
        "not_found",
        "画布不存在或不属于当前工作区。",
        404,
      );
    }

    let bundleDir: string;
    try {
      bundleDir = resolveInsideRoot(sandboxDir, parsed.data.path);
    } catch (error) {
      return sendError(
        reply,
        "invalid_request",
        error instanceof Error ? error.message : "路径不合法。",
        400,
      );
    }

    try {
      // 本机目录安装：url 传绝对路径（bundle-source 认本地路径），生命周期脚本默认拒绝
      const result = await options.registry.install({
        allowLifecycleScripts: false,
        url: bundleDir,
      });
      // 响应形状与 /api/plugins/install 一致：{installed, report}
      return reply.code(201).send(pluginInstallResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof PluginRegistryError) {
        if (error.report) {
          return reply.code(422).send({
            error: { code: "plugin_incompatible", message: error.message },
            report: error.report,
          });
        }
        const status = error.code === "system_plugin" ? 403 : 400;
        return sendError(reply, error.code, error.message, status);
      }
      request.log.error({ err: error }, "sandbox plugin install failed");
      return sendError(reply, "install_failed", "安装失败。", 500);
    }
  });

  /**
   * 插件自带路由：`/api/plugins/<pluginId>/<path>`。
   *
   * 派发而不是注册到 Fastify：插件可以在运行时装卸，Fastify 的路由表注册后不可撤——
   * 一张每次都现查的派发表才能做到「卸载即失效」。默认要求登录，插件可用
   * `public: true` 显式开放（UI 面板 iframe 带不上 Authorization 头）。
   */
  const dispatchPluginRoute = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const params = request.params as { pluginId?: string; "*"?: string };
    const pluginId = params.pluginId ?? "";
    const routePath = params["*"] ?? "";
    const query = (request.query ?? {}) as Record<string, string>;
    if (!pluginId) {
      return sendError(reply, "not_found", "缺少插件 id。", 404);
    }
    const user = await options.auth.authenticate(request);
    const workspaceId = user
      ? await resolveWorkspaceId(options.viewerService, user)
      : undefined;
    const result = await options.registry.dispatchRoute({
      pluginId,
      method: request.method,
      path: routePath,
      query,
      body: request.body,
      headers: request.headers as Record<string, string | undefined>,
      isAuthenticated: Boolean(user),
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!result) {
      return sendError(
        reply,
        "not_found",
        "插件路由不存在（插件可能未安装或未启用）。",
        404,
      );
    }
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      reply.header(name, value);
    }
    if (typeof result.body === "string") {
      // HTML/文本（面板页面）原样下发；plugin 自管的 content-type
      return reply
        .code(result.status)
        .type(result.headers?.["content-type"] ?? "text/html; charset=utf-8")
        .send(result.body);
    }
    return reply.code(result.status).send(result.body);
  };

  /**
   * 插件静态资源：`/api/plugins/<id>/assets/<path>`（只读、公开）。
   *
   * 面板页面若由插件自带，iframe 可以直接加载这里（无需鉴权头）。仅在清单声明
   * `kenfutwork.assets: true` 时开放；越界/点文件/node_modules/超限一律 404。
   */
  app.get<{ Params: { pluginId: string; "*": string } }>(
    "/api/plugins/:pluginId/assets/*",
    async (request, reply) => {
      const asset = await options.registry.readAsset({
        pluginId: request.params.pluginId,
        relativePath: request.params["*"] ?? "",
      });
      if (!asset) {
        return sendError(reply, "not_found", "资源不存在。", 404);
      }
      return reply
        .code(200)
        .header("cache-control", "no-cache")
        .type(asset.contentType)
        .send(asset.content);
    },
  );

  app.get("/api/plugins/:pluginId/*", dispatchPluginRoute);
  app.post("/api/plugins/:pluginId/*", dispatchPluginRoute);

  app.post("/api/plugins/:id/uninstall", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const { id } = request.params as { id: string };
    try {
      await options.registry.uninstall(id);
      return reply.code(200).send({ id, installed: false });
    } catch (error) {
      if (error instanceof PluginRegistryError) {
        const status =
          error.code === "system_plugin"
            ? 403
            : error.code === "not_installed"
              ? 404
              : 400;
        return sendError(reply, error.code, error.message, status);
      }
      request.log.error({ err: error }, "plugin uninstall failed");
      return sendError(reply, "uninstall_failed", "卸载失败。", 500);
    }
  });

  app.post("/api/plugins/:id/toggle", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") {
      return sendError(reply, "invalid_request", "enabled 必须是布尔值。", 400);
    }
    try {
      const updated = await options.registry.setEnabled(id, body.enabled);
      return reply
        .code(200)
        .send({ id: updated.id, installed: updated.enabled });
    } catch (error) {
      if (error instanceof PluginRegistryError) {
        return sendError(
          reply,
          error.code,
          error.message,
          error.code === "not_installed" ? 404 : 400,
        );
      }
      request.log.error({ err: error }, "plugin toggle failed");
      return sendError(reply, "toggle_failed", "切换失败。", 500);
    }
  });

  // 导出产出 bundle 骨架（双声明，两端可装）；不落盘，由客户端决定保存位置
  app.post("/api/plugins/export", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    const parsed = pluginExportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "请求参数不合法。", 400);
    }
    return reply
      .code(200)
      .send(
        options.registry.exportPlugin(parsed.data.name, parsed.data.format),
      );
  });
}
