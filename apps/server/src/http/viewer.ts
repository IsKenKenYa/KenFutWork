// @credits-system — Viewer endpoint: auto-claims daily credits, returns balance and plan info

import {
  applicationErrorResponseSchema,
  PLAN_CONFIGS,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  type SubscriptionPlan,
  unauthenticatedErrorResponseSchema,
  viewerResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { isZodError } from "./zod-error.js";

export async function registerViewerRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/viewer", async (request, reply) => {
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

      const viewer = await options.viewerService.ensureViewer(user);

      // @credits-system: Auto-claim daily credits on login + attach credits info
      let credits: Record<string, unknown> | undefined;
      if (options.creditService) {
        try {
          // Auto-claim daily credits for free users on each viewer request
          // (idempotent — claim_daily_credits is a no-op if already claimed today)
          const balance = await options.creditService.getBalance(
            viewer.workspace.id,
          );
          if (balance.plan === "free" && !balance.dailyClaimed) {
            await options.creditService.claimDailyCredits(viewer.workspace.id);
          }

          // Re-fetch balance after potential claim
          const updatedBalance = await options.creditService.getBalance(
            viewer.workspace.id,
          );
          const config = PLAN_CONFIGS[updatedBalance.plan as SubscriptionPlan];
          credits = {
            balance: updatedBalance.balance,
            plan: updatedBalance.plan,
            dailyClaimed: updatedBalance.dailyClaimed,
            limits: {
              maxConcurrentJobs: config.maxConcurrentJobs,
              maxResolution: config.maxResolution,
              monthlyCredits: config.monthlyCredits,
              dailyCredits: config.dailyCredits,
            },
          };
        } catch {
          // Credits fetch failure is non-fatal — viewer still works
        }
      }

      return reply
        .code(200)
        .send(viewerResponseSchema.parse({ ...viewer, credits }));
    } catch (error) {
      return sendApplicationError(
        error,
        reply,
        "bootstrap_failed",
        "Unable to prepare viewer workspace.",
      );
    }
  });

  app.patch("/api/viewer/profile", async (request, reply) => {
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

      const payload = profileUpdateRequestSchema.parse(request.body);
      const profile = await options.viewerService.updateProfile(
        user,
        payload.displayName,
      );

      return reply
        .code(200)
        .send(profileUpdateResponseSchema.parse({ profile }));
    } catch (error) {
      if (isZodError(error)) {
        return reply.code(400).send({
          issues: error.issues,
          message: "Invalid request body",
        });
      }

      return sendApplicationError(
        error,
        reply,
        "application_error",
        "Internal server error.",
      );
    }
  });
}

function sendApplicationError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: "application_error" | "bootstrap_failed",
  fallbackMessage: string,
) {
  if (isApplicationError(error)) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: fallbackCode,
        message: fallbackMessage,
      },
    }),
  );
}

/** 带 HTTP 语义的领域错误（BootstrapError / ProfileUpdateError 等）。 */
function isApplicationError(
  error: unknown,
): error is { code: string; message: string; statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    "code" in error &&
    typeof error.code === "string"
  );
}
