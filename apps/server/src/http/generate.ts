// @credits-system — Direct generation routes with credit deduction and tier checks

import {
  applicationErrorResponseSchema,
  type ImageQualityLevel,
  unauthenticatedErrorResponseSchema,
  type VideoResolution,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
import { generateImage } from "../generation/image-generation.js";
import { resolveImageProviderName } from "../generation/providers/registry.js";
import { instanceHeadersOption } from "../providers/instance-headers.js";
import { resolveInstanceImageProvider } from "../providers/resolve.js";

const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：用户供应商实例 id；携带时按实例实例化协议适配器（P4）。 */
  providerInstanceId: z.string().uuid().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
  /**
   * 会话标识（§4.8 自定义头占位符的渲染上下文）：画布助手发起时带上当前会话，
   * 使 `{{sessionId}}` 能取到值；确无会话的调用方可缺省（实例若配了占位符会 fail loud）。
   * **口径与 run 路径一致**（`sessionIdSchema` = 非空字符串）——Code 模式的会话 id 是
   * 客户端自造的，按 uuid 校验会把合法值挡在门外。
   */
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：用户供应商实例 id；携带时任务载荷透传，worker 按实例实例化适配器。 */
  providerInstanceId: z.string().uuid().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
  /** 会话标识：随 job 行落库，worker 侧按同一口径渲染自定义头（§4.8）。口径同 run 路径。 */
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

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

    const model = payload.model ?? "black-forest-labs/flux-kontext-pro";

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

      let result;
      if (payload.providerInstanceId && options.modelProviders) {
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
            .filter((m) => m.capability === "image")
            .map((m) => ({ id: m.id, name: m.name })),
        });
        result = await provider.generate({
          prompt: payload.prompt,
          model,
          aspectRatio: payload.aspectRatio ?? "1:1",
          ...(payload.quality ? { quality: payload.quality } : {}),
        });
      } else {
        const providerName = resolveImageProviderName(model);
        result = await generateImage(providerName, {
          prompt: payload.prompt,
          model,
          aspectRatio: payload.aspectRatio ?? "1:1",
          ...(payload.quality ? { quality: payload.quality } : {}),
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

    const model = payload.model ?? "google-official/veo-3.1-generate-preview";

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

      // ── Poll until terminal state ──
      const POLL_INTERVAL = 3_000;
      const MAX_WAIT = 300_000; // 5 minutes

      const result = await pollJobUntilDone(
        options.jobService,
        job.id,
        POLL_INTERVAL,
        MAX_WAIT,
      );

      if ("error" in result) {
        return reply.code(502).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "generation_failed",
              message: result.error,
            },
          }),
        );
      }

      return reply.code(200).send({
        url: result.signed_url,
        assetId: result.asset_id,
        prompt: payload.prompt,
        mimeType: result.mime_type,
        width: result.width,
        height: result.height,
        durationSeconds: result.duration_seconds,
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

// ── Job polling helper ──────────────────────────────────────

type VideoJobResult = {
  signed_url: string;
  asset_id: string;
  width: number;
  height: number;
  duration_seconds: number;
  mime_type: string;
};

type PollResult = VideoJobResult | { error: string };

async function pollJobUntilDone(
  jobService: JobService,
  jobId: string,
  pollInterval: number,
  maxWait: number,
): Promise<PollResult> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await delay(pollInterval);

    const current = await jobService.getJobAdmin(jobId);

    if (current.status === "succeeded" && current.result) {
      const r = current.result as Record<string, unknown>;
      return {
        signed_url: (r.signed_url as string) ?? "",
        asset_id: (r.asset_id as string) ?? "",
        width: (r.width as number) ?? 0,
        height: (r.height as number) ?? 0,
        duration_seconds: (r.duration_seconds as number) ?? 0,
        mime_type: (r.mime_type as string) ?? "video/mp4",
      };
    }

    if (current.status === "dead_letter" || current.status === "canceled") {
      return { error: current.error_message ?? `Job ${current.status}` };
    }

    if (
      current.status === "failed" &&
      current.attempt_count >= current.max_attempts
    ) {
      return {
        error: current.error_message ?? "Job failed after max retries",
      };
    }
  }

  return { error: `Job timed out after ${maxWait / 1000}s` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
