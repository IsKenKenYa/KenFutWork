import {
  applicationErrorResponseSchema,
  modelCatalogResponseSchema,
  providerInstanceCreateRequestSchema,
  providerInstanceListResponseSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  type ModelProviderService,
  ModelProviderServiceError,
} from "../features/model-providers/model-provider-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

function sendError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: string,
): FastifyReply {
  if (error instanceof ModelProviderServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: fallbackCode, message: "Internal provider error." },
    }),
  );
}

export async function registerProviderInstanceRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    modelProviders: ModelProviderService;
  },
) {
  // GET /api/provider-instances — 列出实例（凭证红线：只含 hasCredential）
  app.get("/api/provider-instances", async (request, reply) => {
    try {
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
      const instances = await options.modelProviders.listInstances(user);
      return reply
        .code(200)
        .send(providerInstanceListResponseSchema.parse({ instances }));
    } catch (error) {
      return sendError(error, reply, "instance_query_failed");
    }
  });

  // POST /api/provider-instances — 创建实例（apiKey 只写）
  app.post("/api/provider-instances", async (request, reply) => {
    try {
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
      const input = providerInstanceCreateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.createInstance(user, input);
      return reply
        .code(201)
        .send(providerInstanceResponseSchema.parse(instance));
    } catch (error) {
      return sendError(error, reply, "instance_create_failed");
    }
  });

  // PATCH /api/provider-instances/:instanceId — 更新（apiKey 缺省即不改，更新即覆盖）
  app.patch("/api/provider-instances/:instanceId", async (request, reply) => {
    try {
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
      const { instanceId } = request.params as { instanceId: string };
      const input = providerInstanceUpdateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.updateInstance(
        user,
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

  // DELETE /api/provider-instances/:instanceId
  app.delete("/api/provider-instances/:instanceId", async (request, reply) => {
    try {
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
      const { instanceId } = request.params as { instanceId: string };
      await options.modelProviders.deleteInstance(user, instanceId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply, "instance_delete_failed");
    }
  });
}
