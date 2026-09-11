import {
  applicationErrorResponseSchema,
  permissionTierSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";

import type { PermissionService } from "../features/permissions/permission-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerPermissionRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    permissions: PermissionService;
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

  // PUT /api/permissions/tier — 设置档位（full-access 属明示开启）
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
    try {
      const tier = permissionTierSchema.parse(
        (request.body as { tier?: unknown }).tier,
      );
      options.permissions.setTier(undefined, tier);
      return reply.code(200).send({ tier });
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_request", message: "Invalid tier." },
        }),
      );
    }
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
