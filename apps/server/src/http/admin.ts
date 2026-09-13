import {
  adminGrantCreditsRequestSchema,
  adminMeResponseSchema,
  adminPlatformUsageResponseSchema,
  adminSetRoleRequestSchema,
  adminSystemInstanceCreateRequestSchema,
  adminSystemInstanceListResponseSchema,
  adminSystemInstanceUpdateRequestSchema,
  adminUserListResponseSchema,
  applicationErrorResponseSchema,
  providerInstanceResponseSchema,
  setPlanRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  type AdminService,
  AdminServiceError,
} from "../features/admin/admin-service.js";
import {
  type ModelProviderService,
  ModelProviderServiceError,
} from "../features/model-providers/model-provider-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

/**
 * 平台管理后台路由（FORM-10）。**全部端点过 requireAdmin → 非管理员 403**：
 * 前端隐藏菜单不是安全边界，权限判定只在服务端。
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    admin: AdminService;
    modelProviders: ModelProviderService;
  },
) {
  /** 认证 + 管理员门；任一失败时已写好响应，返回 null 表示调用方应直接 return。 */
  async function gate(
    request: Parameters<RequestAuthenticator["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | null> {
    const user = await options.auth.authenticate(request);
    if (!user) {
      reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
      return null;
    }
    try {
      await options.admin.requireAdmin(user);
    } catch (error) {
      sendError(error, reply, "forbidden");
      return null;
    }
    return user;
  }

  // GET /api/admin/me — 前端据此决定是否显示后台入口
  app.get("/api/admin/me", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }
    const isAdmin = await options.admin.isAdmin(user.id);
    return reply.code(200).send(adminMeResponseSchema.parse({ isAdmin }));
  });

  // GET /api/admin/users — 用户 + 工作区 + 套餐/额度 + 用量汇总
  app.get("/api/admin/users", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const users = await options.admin.listUsers();
      return reply.code(200).send(adminUserListResponseSchema.parse({ users }));
    } catch (error) {
      return sendError(error, reply, "admin_query_failed");
    }
  });

  // GET /api/admin/usage — 平台用量总览
  app.get("/api/admin/usage", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const usage = await options.admin.platformUsage();
      return reply
        .code(200)
        .send(adminPlatformUsageResponseSchema.parse(usage));
    } catch (error) {
      return sendError(error, reply, "admin_query_failed");
    }
  });

  // POST /api/admin/users/:userId/credits — 调剂额度（正发负扣）
  app.post("/api/admin/users/:userId/credits", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const { userId } = request.params as { userId: string };
      const body = adminGrantCreditsRequestSchema.parse(request.body);
      await options.admin.grantCredits(userId, body.amount, body.description);
      const users = await options.admin.listUsers();
      return reply.code(200).send(adminUserListResponseSchema.parse({ users }));
    } catch (error) {
      return sendError(error, reply, "admin_action_failed");
    }
  });

  // POST /api/admin/users/:userId/plan — 设置套餐（额度/并发/模型档位随之）
  app.post("/api/admin/users/:userId/plan", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const { userId } = request.params as { userId: string };
      const body = setPlanRequestSchema.parse(request.body);
      await options.admin.setPlan(userId, body.plan);
      const users = await options.admin.listUsers();
      return reply.code(200).send(adminUserListResponseSchema.parse({ users }));
    } catch (error) {
      return sendError(error, reply, "admin_action_failed");
    }
  });

  // POST /api/admin/users/:userId/role — 授予/回收管理员（拒绝自降级防锁死）
  app.post("/api/admin/users/:userId/role", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const { userId } = request.params as { userId: string };
      const body = adminSetRoleRequestSchema.parse(request.body);
      if (userId === user.id && body.role !== "admin") {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_action",
              message: "不能回收自己的管理员权限。",
            },
          }),
        );
      }
      await options.admin.setRole(userId, body.role);
      const users = await options.admin.listUsers();
      return reply.code(200).send(adminUserListResponseSchema.parse({ users }));
    } catch (error) {
      return sendError(error, reply, "admin_action_failed");
    }
  });

  // ── 系统供应商（平台池）────────────────────────────────────

  app.get("/api/admin/providers", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const instances = await options.modelProviders.listSystemInstances();
      return reply
        .code(200)
        .send(adminSystemInstanceListResponseSchema.parse({ instances }));
    } catch (error) {
      return sendError(error, reply, "instance_query_failed");
    }
  });

  app.post("/api/admin/providers", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const input = adminSystemInstanceCreateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.createSystemInstance(
        input,
        user.id,
      );
      return reply
        .code(201)
        .send(providerInstanceResponseSchema.parse(instance));
    } catch (error) {
      return sendError(error, reply, "instance_create_failed");
    }
  });

  app.patch("/api/admin/providers/:instanceId", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const { instanceId } = request.params as { instanceId: string };
      const input = adminSystemInstanceUpdateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.updateSystemInstance(
        instanceId,
        input,
      );
      return reply
        .code(200)
        .send(providerInstanceResponseSchema.parse(instance));
    } catch (error) {
      return sendError(error, reply, "instance_update_failed");
    }
  });

  app.delete("/api/admin/providers/:instanceId", async (request, reply) => {
    const user = await gate(request, reply);
    if (!user) return reply;
    try {
      const { instanceId } = request.params as { instanceId: string };
      await options.modelProviders.deleteSystemInstance(instanceId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply, "instance_delete_failed");
    }
  });
}

function sendError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: string,
): FastifyReply {
  if (error instanceof AdminServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof ModelProviderServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: fallbackCode, message: "Internal admin error." },
    }),
  );
}
