import {
  applicationErrorResponseSchema,
  permissionTierSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { PermissionService } from "../features/permissions/permission-service.js";
import type { PermissionTierStore } from "../features/permissions/tier-store.js";

export async function registerPermissionRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    permissions: PermissionService;
    /** 全局档位写穿（app_config）；缺省时仅内存生效（部分装配/单测）。 */
    tierStore?: PermissionTierStore;
  },
) {
  // GET /api/permissions/tier — 当前权限档
  app.get("/api/permissions/tier", async (request, reply) => {
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
    return reply.code(200).send({
      tier: permissionTierSchema.parse(options.permissions.getTier()),
    });
  });

  // PUT /api/permissions/tier — 设置档位（full-access 属明示开启；写穿持久化）
  app.put("/api/permissions/tier", async (request, reply) => {
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
    let tier: import("@loomic/shared").PermissionTier;
    try {
      tier = permissionTierSchema.parse(
        (request.body as { tier?: unknown }).tier,
      );
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_request", message: "Invalid tier." },
        }),
      );
    }
    // 先写库再改内存：写失败即 500（静默漂移正是本次要消灭的故障形态——
    // 内存保持旧档，UI 与服务端不会出现「显示已放行、实际 default」的分裂）
    if (options.tierStore) {
      try {
        await options.tierStore.save(tier);
      } catch (error) {
        return reply.code(500).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "internal_error",
              message: `权限档位保存失败，档位未变更：${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          }),
        );
      }
    }
    options.permissions.setTier(undefined, tier);
    return reply.code(200).send({ tier });
  });

  // POST /api/permissions/approve — 人审放行（agent 无自我授权路径）
  app.post("/api/permissions/approve", async (request, reply) => {
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
    try {
      const body = request.body as {
        toolName?: string;
        scope?: "once" | "thread" | "forever";
        threadId?: string;
      };
      if (!body.toolName) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_request", message: "toolName required." },
          }),
        );
      }
      options.permissions.approve(body.toolName, {
        scope: body.scope ?? "once",
        ...(body.threadId ? { threadId: body.threadId } : {}),
      });
      return reply.code(204).send();
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_request", message: "Invalid body." },
        }),
      );
    }
  });
}
