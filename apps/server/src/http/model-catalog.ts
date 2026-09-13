import {
  applicationErrorResponseSchema,
  modelCatalogResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";

export async function registerModelCatalogRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    modelCatalog: ModelCatalogService;
  },
) {
  // GET /api/model-catalog — 从用户供应商实例推导的动态模型目录
  app.get("/api/model-catalog", async (request, reply) => {
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
      const models = await options.modelCatalog.listCatalog(user);
      return reply.code(200).send(modelCatalogResponseSchema.parse({ models }));
    } catch (error) {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "model_catalog_query_failed",
            message: "Unable to load model catalog.",
          },
        }),
      );
    }
  });
}
