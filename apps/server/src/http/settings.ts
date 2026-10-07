import {
  applicationErrorResponseSchema,
  instanceSettingsResponseSchema,
  instanceSettingsUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessService } from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import {
  type SettingsService,
  SettingsServiceError,
} from "../features/settings/settings-service.js";
import { describeZodIssues, isZodError } from "./zod-error.js";

export async function registerSettingsRoutes(
  app: FastifyInstance,
  options: {
    localAccess: Pick<LocalAccessService, "authenticate">;
    localInstance: LocalInstanceService;
    settingsService: SettingsService;
    modelCatalog: Pick<ModelCatalogService, "validateSpecifier">;
  },
) {
  app.get("/api/instance/settings", async (request, reply) => {
    try {
      const actor = await options.localAccess.authenticate(request);
      if (!actor) return sendUnauthorized(reply);
      const { instanceId } = await options.localInstance.resolve(actor);
      const settings = await options.settingsService.getInstanceSettings(
        actor,
        instanceId,
      );
      return reply
        .code(200)
        .send(instanceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendSettingsError(error, reply);
    }
  });

  app.patch("/api/instance/settings", async (request, reply) => {
    try {
      const actor = await options.localAccess.authenticate(request);
      if (!actor) return sendUnauthorized(reply);
      const { instanceId } = await options.localInstance.resolve(actor);
      const payload = instanceSettingsUpdateRequestSchema.parse(request.body);
      if (payload.defaultModel) {
        const verdict = await options.modelCatalog.validateSpecifier(
          actor,
          payload.defaultModel,
        );
        if (!verdict.ok) {
          return reply.code(400).send(
            applicationErrorResponseSchema.parse({
              error: { code: "invalid_model", message: verdict.message },
            }),
          );
        }
      }
      const settings = await options.settingsService.updateInstanceSettings(
        actor,
        instanceId,
        payload,
      );
      return reply
        .code(200)
        .send(instanceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendSettingsError(error, reply);
    }
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "缺少或无效的本机接入凭据。" },
    }),
  );
}

function sendSettingsError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof SettingsServiceError ||
    error instanceof LocalInstanceError
  ) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (isZodError(error)) {
    return reply.code(400).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: describeZodIssues(error.issues),
        },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: "settings_failed", message: "本地实例设置读写失败。" },
    }),
  );
}
