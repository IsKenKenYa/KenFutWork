import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSettingsResponseSchema,
  workspaceSettingsUpdateRequestSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import {
  type SettingsService,
  SettingsServiceError,
} from "../features/settings/settings-service.js";
import { isZodError } from "./zod-error.js";

export async function registerSettingsRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    settingsService: SettingsService;
    viewerService: ViewerService;
    /** 保存默认模型时校验「目录里真有这个模型」（缺省跳过校验：部分装配/单测）。 */
    modelCatalog?: ModelCatalogService | undefined;
  },
) {
  app.get("/api/workspace/settings", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const settings = await options.settingsService.getWorkspaceSettings(
        user,
        viewer.workspace.id,
      );

      return reply
        .code(200)
        .send(workspaceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendSettingsError(error, reply);
    }
  });

  app.put("/api/workspace/settings", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const payload = workspaceSettingsUpdateRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);

      /**
       * 保存期 fail loud（E）：模型名不在目录里就直接 400 并给出可用清单。
       * 此前不校验，界面上「保存成功」而第一次 run 才失败、且只有通用文案。
       */
      if (payload.defaultModel && options.modelCatalog) {
        const verdict = await options.modelCatalog.validateSpecifier(
          user,
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

      const settings = await options.settingsService.updateWorkspaceSettings(
        user,
        viewer.workspace.id,
        payload,
      );

      return reply
        .code(200)
        .send(workspaceSettingsResponseSchema.parse({ settings }));
    } catch (error) {
      return sendSettingsError(error, reply);
    }
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendSettingsError(error: unknown, reply: FastifyReply) {
  if (error instanceof SettingsServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  if (isZodError(error)) {
    return reply.code(400).send({
      issues: error.issues,
      message: "Invalid request body",
    });
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "Internal server error.",
      },
    }),
  );
}
