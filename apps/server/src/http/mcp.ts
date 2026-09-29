import {
  applicationErrorResponseSchema,
  mcpServerCreateRequestSchema,
  mcpServerUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AdminService } from "../features/admin/admin-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import { CURATED_MCP_SERVERS } from "../features/mcp/curated-catalog.js";
import type { McpService } from "../features/mcp/mcp-service.js";
import { searchOfficialRegistry } from "../features/mcp/registry-client.js";

/**
 * MCP server 管理路由（新增：此前只能改环境变量）。
 *
 * 权限模型与插件市场同口径：**读取**（列表/状态）只需登录；
 * **变更**（增删改/启停/重连）额外要求管理员——MCP server 以 stdio 子进程
 * 在本机执行任意命令，属实例级危险操作。
 */

export interface McpRoutesDeps {
  auth: RequestAuthenticator;
  admin: AdminService;
  service: McpService;
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
  return reply
    .code(status)
    .send(applicationErrorResponseSchema.parse({ error: { code, message } }));
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  options: McpRoutesDeps,
) {
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
      void sendError(reply, "forbidden", "需要管理员权限 · 请用管理员账号登录", 403);
      return false;
    }
    return true;
  };

  // GET /api/mcp/servers — 列表与运行状态（env 键名，不含值）
  app.get("/api/mcp/servers", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    return reply
      .code(200)
      .send({ servers: await options.service.listStatuses() });
  });

  // GET /api/mcp/catalog — 内置精选目录（离线可用，一键添加）
  app.get("/api/mcp/catalog", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    return reply.code(200).send({ servers: CURATED_MCP_SERVERS });
  });

  // GET /api/mcp/registry — 官方 MCP Registry 检索（代理；无需密钥）
  // 只读：登录即可。检索词走官方 `search`（对名称做子串匹配）。
  app.get("/api/mcp/registry", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    const { q = "", limit = "20" } = request.query as Record<string, string>;
    try {
      const result = await searchOfficialRegistry(
        q,
        Number.parseInt(limit, 10) || 20,
      );
      return reply.code(200).send(result);
    } catch (error) {
      return sendError(
        reply,
        "mcp_registry_unavailable",
        `官方 MCP 注册表暂不可用：${
          error instanceof Error ? error.message : String(error)
        }`,
        502,
      );
    }
  });

  // POST /api/mcp/servers — 新增（连接失败不报错：状态里可查原因）
  app.post("/api/mcp/servers", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = mcpServerCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "配置格式不正确。", 400);
    }
    try {
      const server = await options.service.create(parsed.data);
      return reply.code(201).send({ server });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 唯一约束：同名 server 已存在
      if (/duplicate|unique/i.test(message)) {
        return sendError(
          reply,
          "mcp_server_exists",
          "同名 MCP server 已存在。",
          409,
        );
      }
      return sendError(reply, "mcp_server_create_failed", message, 500);
    }
  });

  // PATCH /api/mcp/servers/:id — 改配置/启停（改完自动重连收敛）
  app.patch("/api/mcp/servers/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = mcpServerUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "配置格式不正确。", 400);
    }
    const { id } = request.params as { id: string };
    const server = await options.service.update(id, parsed.data);
    if (!server) {
      return sendError(
        reply,
        "mcp_server_not_found",
        "MCP server 不存在。",
        404,
      );
    }
    return reply.code(200).send({ server });
  });

  // DELETE /api/mcp/servers/:id — 删除并断开
  app.delete("/api/mcp/servers/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const removed = await options.service.remove(id);
    if (removed === 0) {
      return sendError(
        reply,
        "mcp_server_not_found",
        "MCP server 不存在。",
        404,
      );
    }
    return reply.code(204).send();
  });

  // POST /api/mcp/servers/:id/reconnect — 手动重连
  app.post("/api/mcp/servers/:id/reconnect", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const status = await options.service.reconnect(id);
    if (!status) {
      return sendError(
        reply,
        "mcp_server_not_found",
        "MCP server 不存在。",
        404,
      );
    }
    return reply.code(200).send({ server: status });
  });
}
