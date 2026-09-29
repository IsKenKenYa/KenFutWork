// @credits-system — Direct generation routes with credit deduction and tier checks

import {
  applicationErrorResponseSchema,
  generateImageRequestSchema,
  generateVideoRequestSchema,
  type ImageQualityLevel,
  unauthenticatedErrorResponseSchema,
  type VideoResolution,
} from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { GeneratedImage } from "../generation/types.js";
import { instanceHeadersOption } from "../providers/instance-headers.js";
import { resolveInstanceImageProvider } from "../providers/resolve.js";

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService?: JobService;
    /** BYOK 实例凭证解析（直连生成按实例实例化适配器）。 */
    modelProviders?: ModelProviderService;
    tierGuard?: TierGuard;
    uploadService: UploadService;
    viewerService: ViewerService;
  },
) {
  app.post("/api/agent/generate-image", async (request, reply) => {
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

    let payload: z.infer<typeof generateImageRequestSchema>;
    try {
      payload = generateImageRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    // BYOK-only（2026-09-18 用户拍板删除内置目录/遗留 env 注册）：必须指定供应商实例。
    if (!payload.providerInstanceId || !options.modelProviders) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message:
              "缺少 providerInstanceId——请先在「设置 → 供应商」添加供应商实例后再发起生成。",
          },
        }),
      );
    }
    const model = payload.model;
    if (!model) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "缺少 model（从实例模型清单中选择）。",
          },
        }),
      );
    }

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        const sub = await options.creditService.getSubscription(
          viewer.workspace.id,
        );
        const quality: ImageQualityLevel = payload.quality ?? "hd";
        options.tierGuard.checkModelAccess(sub.plan, model);
        // Throws TierGuardError (resolution_not_allowed) if plan doesn't allow this quality
        options.tierGuard.checkResolution(sub.plan, quality);
        await options.tierGuard.checkConcurrency(viewer.workspace.id, sub.plan);
        creditsCost = options.tierGuard.calculateCreditCost(
          model,
          "image_generation",
          { quality },
        );

        // Deduct credits before generation
        if (creditsCost > 0) {
          await options.creditService.deductCredits(
            viewer.workspace.id,
            user.id,
            creditsCost,
            undefined,
            `Direct image generation: ${model}`,
          );
        }
      }

      let result: GeneratedImage;
      {
        const credentials = await options.modelProviders.resolveCredentialsById(
          payload.providerInstanceId,
        );
        const provider = resolveInstanceImageProvider(credentials.protocol, {
          credentials: {
            apiKey: credentials.apiKey,
            ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
            // 自定义头（§4.8）占位符按请求携带的会话渲染；确无会话时由渲染层 fail loud
            // 给出可读原因，而不是发出字面量 `{{sessionId}}`。
            ...instanceHeadersOption(credentials.headers, {
              sessionId: payload.sessionId,
              threadId: payload.threadId,
            }),
          },
          models: credentials.models
            .filter(
              (m) => m.capability === "image" || m.capability === "image-edit",
            )
            .map((m) => ({ id: m.id, name: m.name })),
        });
        result = await provider.generate({
          prompt: payload.prompt,
          model,
          aspectRatio: payload.aspectRatio ?? "1:1",
          ...(payload.quality ? { quality: payload.quality } : {}),
          ...(payload.inputImages?.length
            ? { inputImages: payload.inputImages }
            : {}),
        });
      }

      // Download and persist to Supabase Storage
      const { signedUrl, assetId } = await downloadAndUpload(
        result.url,
        result.mimeType,
        payload.prompt,
        user,
        options,
      );

      return reply.code(200).send({
        url: signedUrl,
        assetId,
        prompt: payload.prompt,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      // Handle tier/credit errors
      if (error instanceof TierGuardError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof CreditServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Image generation failed.";

      if (message.includes("No provider registered")) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "provider_not_configured",
              message: "Image generation is not available.",
            },
          }),
        );
      }

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
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

    let payload: z.infer<typeof generateVideoRequestSchema>;
    try {
      payload = generateVideoRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message:
              "Video generation is not available (job service not configured).",
          },
        }),
      );
    }

    // BYOK-only（2026-09-18 用户拍板）：必须指定供应商实例与模型。
    if (
      !payload.providerInstanceId ||
      !options.modelProviders ||
      !options.jobService
    ) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message:
              "缺少 providerInstanceId——请先在「设置 → 供应商」添加供应商实例后再发起生成。",
          },
        }),
      );
    }
    if (!payload.model) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "缺少 model（从实例模型清单中选择）。",
          },
        }),
      );
    }
    const model = payload.model;

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        const sub = await options.creditService.getSubscription(workspaceId);
        options.tierGuard.checkModelAccess(sub.plan, model);
        if (payload.resolution) {
          options.tierGuard.checkVideoResolution(
            sub.plan,
            payload.resolution as VideoResolution,
          );
        }
        await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
        creditsCost = options.tierGuard.calculateCreditCost(
          model,
          "video_generation",
          {
            ...(payload.duration != null ? { duration: payload.duration } : {}),
            ...(payload.resolution
              ? { resolution: payload.resolution as VideoResolution }
              : {}),
          },
        );
      }

      // ── Create job ──
      const job = await options.jobService.createJob(user, {
        jobType: "video_generation",
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
        payload: {
          prompt: payload.prompt,
          model,
          ...(payload.providerInstanceId
            ? { provider_instance_id: payload.providerInstanceId }
            : {}),
          ...(payload.duration != null ? { duration: payload.duration } : {}),
          ...(payload.resolution ? { resolution: payload.resolution } : {}),
          ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
          ...(payload.inputImages?.length
            ? { input_images: payload.inputImages }
            : {}),
        },
      });

      // ── Deduct credits BEFORE generation ──
      if (options.creditService && creditsCost > 0) {
        try {
          const txId = await options.creditService.deductCredits(
            workspaceId,
            user.id,
            creditsCost,
            job.id,
            `Direct video generation: ${model}`,
          );
          await options.jobService.setCreditsInfo(job.id, creditsCost, txId);
        } catch (deductError) {
          await options.jobService.cancelJob(user, job.id).catch(() => {});
          throw deductError;
        }
      }

      // ── 异步受理（S6）：任务由 worker 执行（异步任务面 submit + 队列轮询），
      // HTTP 请求不在请求内挂起等结果（台账遗留：5 分钟内联轮询退役）。
      // 进度经 GET /api/jobs/:id 轮询。
      return reply.code(202).send({
        job_id: job.id,
        status: "queued",
        prompt: payload.prompt,
      });
    } catch (error) {
      if (error instanceof TierGuardError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof CreditServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Video generation failed.";

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });
}

// ── Image download + upload helper ──────────────────────────

async function downloadAndUpload(
  sourceUrl: string,
  mimeType: string,
  prompt: string,
  user: AuthenticatedUser,
  deps: { uploadService: UploadService; viewerService: ViewerService },
): Promise<{ signedUrl: string; assetId: string }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;

  // 引导工作区（幂等）；工作区 id 由 uploadService 内部解析。
  await deps.viewerService.ensureViewer(user);

  const result = await deps.uploadService.uploadFile(user, {
    bucket: "project-assets",
    fileName,
    fileBuffer: buffer,
    mimeType,
  });

  return { signedUrl: result.url, assetId: result.asset.id };
}
