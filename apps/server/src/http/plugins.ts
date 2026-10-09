import {
  type ApplicationErrorCode,
  applicationErrorResponseSchema,
  pluginExportRequestSchema,
  pluginInspectRequestSchema,
  pluginInspectResponseSchema,
  pluginInstallBuiltinRequestSchema,
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
  pluginToggleResponseSchema,
  sandboxPluginBundleListResponseSchema,
  sandboxPluginInstallRequestSchema,
  unauthenticatedErrorResponseSchema,
  workDirectoryTargetSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CanvasRepository } from "../features/canvas/repository.js";
import type { ExecutionScopes } from "../features/execution/scope-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import { createScopedBundleSource } from "../features/plugins/bundle-source.js";
import type { PluginRegistryService } from "../features/plugins/plugin-registry-service.js";
import { PluginRegistryError } from "../features/plugins/plugin-registry-service.js";
import {
  listSandboxPluginBundles,
  listScopedPluginBundles,
} from "../features/plugins/sandbox-plugin-bundles.js";
import type { ProjectService } from "../features/projects/project-service.js";
import { resolveInsideRoot } from "../utils/inside-root.js";
import { resolveWorkDirectoryTarget } from "./sandbox-scope.js";

/**
 * 插件市场与安装路由。
 *
 * 权限模型：**读取**（列表/校验/导出）只需登录；**变更**（安装/卸载/启停）额外要求
 * 管理员——安装会拉取并在本机执行第三方代码，是实例级危险操作，不能给普通用户。
 * 安装前一律先过兼容性门禁，未通过即 422 并回传完整报告（不落盘、不装载）。
 */

export interface PluginRoutesDeps {
  localAccess: LocalAccessVerifier;
  registry: PluginRegistryService;
  /** 「从工作目录安装」需要：画布归属校验 + 沙箱目录解析（与技能/agent 同一处）。 */
  canvasRepository: CanvasRepository;
  projects: Pick<ProjectService, "getProject">;
  executionScopes: Pick<ExecutionScopes, "openTask">;
  localInstance: LocalInstanceService;
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
  /** 项目绑定的本机工作目录（`projects.work_dir`）；界面绑定优先于环境变量映射。 */
  projectWorkDirLoader?:
    | ((instanceId: string, canvasId: string) => Promise<string | null>)
    | undefined;
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "请从桌面重新建立本机连接。" },
    }),
  );
}

/**
 * 插件路由的工作区上下文：与其它聚合同一口径（viewer 解析当前用户的工作区）。
 *
 * 解析失败（例如身份已建但个人工作区缺失）**不在这里 500**：公共面板路由本就没有身份，
 * 而插件真的读写存储时，存储层会因缺工作区 fail loud——报错点离出错点更近，更好排查。
 */
async function resolveId(
  localInstance: LocalInstanceService,
  user: LocalActor,
): Promise<string | undefined> {
  try {
    const workspace = await localInstance.resolve(user);
    return workspace.instanceId;
  } catch {
    return undefined;
  }
}

/**
 * 统一错误响应。`code` 收窄成契约里的封闭枚举——写一个不在枚举里的码（历史上是 `not_found`）
 * 会让 `parse` 抛错、响应退化成 ZodError 转储，可读原因当场丢失。
 */
function sendError(
  reply: FastifyReply,
  code: ApplicationErrorCode,
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
  /** 本机接入验证（变更类端点用）。 */
  const requireAccess = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<boolean> => {
    const user = await options.localAccess.authenticate(request);
    if (!user) {
      void sendUnauthenticated(reply);
      return false;
    }
    return true;
  };

  app.get("/api/plugins", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    return reply.code(200).send({ plugins: await options.registry.list() });
  });

  // 只校验不安装：让 UI 在用户点「安装」前就能看到门禁结论
  app.post("/api/plugins/inspect", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    if (!(await requireAccess(request, reply))) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed =
      "builtin" in body
        ? pluginInstallBuiltinRequestSchema.safeParse(request.body)
        : pluginInstallRequestSchema.safeParse(request.body);
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
  app.get<{ Querystring: { canvasId?: string; taskId?: string } }>(
    "/api/plugins/sandbox-bundles",
    async (request, reply) => {
      const user = await options.localAccess.authenticate(request);
      if (!user) return sendUnauthenticated(reply);
      const target = workDirectoryTargetSchema.safeParse(request.query);
      if (!target.success)
        return sendError(
          reply,
          "invalid_request",
          "请明确提供 Task 或可视化 Canvas 身份。",
          400,
        );
      try {
        const directory = await resolveWorkDirectoryTarget(
          options,
          user,
          target.data,
        );
        const bundles = directory.scope
          ? await listScopedPluginBundles(directory.scope)
          : listSandboxPluginBundles(directory.rootDirectory);
        return reply
          .code(200)
          .send(sandboxPluginBundleListResponseSchema.parse({ bundles }));
      } catch (error) {
        return sendError(
          reply,
          "invalid_request",
          error instanceof Error ? error.message : "目录读取失败。",
          error && typeof error === "object" && "statusCode" in error
            ? Number(error.statusCode)
            : 400,
        );
      }
    },
  );

  // POST /api/plugins/sandbox-install — 把工作目录里的 bundle 目录安装到本实例
  // 与 /api/plugins/install 同一本机接入门：插件会加载执行第三方代码（本机目录也不例外）
  app.post("/api/plugins/sandbox-install", async (request, reply) => {
    if (!(await requireAccess(request, reply))) return reply;

    const parsed = sandboxPluginInstallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "请求参数不合法。", 400);
    }
    const user = await options.localAccess.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    let directory: Awaited<ReturnType<typeof resolveWorkDirectoryTarget>>;
    let bundleDir: string;
    try {
      const target =
        "taskId" in parsed.data
          ? { taskId: parsed.data.taskId }
          : { canvasId: parsed.data.canvasId };
      directory = await resolveWorkDirectoryTarget(options, user, target);
      bundleDir = directory.scope
        ? await directory.scope.resolvePath(parsed.data.path, "read")
        : resolveInsideRoot(directory.rootDirectory, parsed.data.path);
    } catch (error) {
      return sendError(
        reply,
        "invalid_request",
        error instanceof Error ? error.message : "目录授权不可用。",
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode)
          : 400,
      );
    }

    try {
      // 本机目录安装：url 传绝对路径（bundle-source 认本地路径），生命周期脚本默认拒绝
      const result = await options.registry.install({
        allowLifecycleScripts: false,
        url: bundleDir,
        ...(directory.scope
          ? { localSource: createScopedBundleSource(directory.scope) }
          : {}),
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
      return sendError(reply, "invalid_request", "缺少插件 id。", 404);
    }
    const user = await options.localAccess.authenticate(request);
    const instanceId = user
      ? await resolveId(options.localInstance, user)
      : undefined;
    const result = await options.registry.dispatchRoute({
      pluginId,
      method: request.method,
      path: routePath,
      query,
      body: request.body,
      headers: request.headers as Record<string, string | undefined>,
      isAuthenticated: Boolean(user),
      ...(instanceId ? { instanceId } : {}),
    });
    if (!result) {
      return sendError(
        reply,
        "plugin_not_found",
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
        return sendError(reply, "plugin_asset_not_found", "资源不存在。", 404);
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
    if (!(await requireAccess(request, reply))) return reply;
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
    if (!(await requireAccess(request, reply))) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") {
      return sendError(reply, "invalid_request", "enabled 必须是布尔值。", 400);
    }
    try {
      const updated = await options.registry.setEnabled(id, body.enabled);
      return reply.code(200).send(
        pluginToggleResponseSchema.parse({
          id: updated.id,
          installed: true,
          enabled: updated.enabled,
        }),
      );
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
    const user = await options.localAccess.authenticate(request);
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
