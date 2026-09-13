import {
  applicationErrorResponseSchema,
  pluginExportRequestSchema,
  pluginInspectRequestSchema,
  pluginInspectResponseSchema,
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AdminService } from "../features/admin/admin-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { PluginRegistryService } from "../features/plugins/plugin-registry-service.js";
import { PluginRegistryError } from "../features/plugins/plugin-registry-service.js";

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
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "请先登录。" },
    }),
  );
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
